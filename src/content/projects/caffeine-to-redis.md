---
title: "Caffeine Local Cache에서 Redis 기반 Distributed Cache로 전환"
company: "N Tech Service"
category: "Cache Architecture"
summary: "서버별 Local Cache로 인해 ACL API 변경 사항이 즉시 반영되지 않는 문제를 Redis 기반 중앙 Cache 구조로 개선"
skills:
  - Java
  - Spring Boot
  - Spring Cache
  - Caffeine
  - Redis
featured: true
order: 1
draft: false
---

## Architecture at a Glance

```text
Before                           After

Application A ── Caffeine A      Application A ──┐
Application B ── Caffeine B      Application B ──┼── Redis Cluster
Application C ── Caffeine C      Application C ──┘

서버마다 별도 Cache                 모든 서버가 중앙 Cache 공유
변경 후 TTL 만료를 기다릴 수 있음    DB 변경 후 관련 Key를 중앙에서 제거
```

핵심은 Cache Hit 속도가 아니라 **모든 Application이 변경된 ACL API 정보를 같은 시점에 사용하도록 하는 것**이었다. Spring Cache Abstraction은 유지하고 CacheManager를 Caffeine에서 Redis로 전환했다.

## Overview

시스템은 외부 ACL API 호출에 필요한 URL과 Endpoint 정보를 DB에서 관리했다. 매 요청마다 DB를 조회하지 않도록 Spring Cache Abstraction과 Caffeine으로 이 정보를 Local Cache에 저장했다.

시스템이 여러 Application과 Server로 구성되면서 각 Instance가 독립적인 Cache를 갖게 됐다. Local Cache의 TTL은 5분이었다. ACL API 정보는 자주 바뀌지 않았지만, 변경 시에는 새 정보를 즉시 사용해야 했다. 한 Instance의 Cache를 제거해도 다른 Instance에는 이전 정보가 남을 수 있어, 사내 Redis Cluster를 이용한 중앙 Cache로 전환했다.

## Background & Impact

ACG/ACL 요청서를 처리할 때 외부 ACL API를 호출하려면 해당 API 정보가 필요하다. 기존 Cache Miss에서는 DB에서 정보를 읽어 Caffeine에 저장했고, 이후에는 각 Application이 자신의 Local Cache를 조회했다.

```text
ACL API 정보 변경: v1 → v2

Application A / Caffeine: v2
Application B / Caffeine: v1
Application C / Caffeine: v1
```

이전 Endpoint를 호출하면 ACL 등록 요청이 실패할 수 있었다. 등록이 누락되면 필요한 Network 통신에도 영향을 줄 수 있다. 따라서 최대 5분 동안 이전 정보가 남을 수 있는 TTL만으로는 이 데이터의 최신성 요구를 충족하기 어려웠다.

## Analysis

문제의 핵심은 Cache의 조회 속도보다 **Cache가 적용되는 범위**였다. Caffeine은 Application Process 안에서 동작하므로 다른 Instance의 값을 한 곳에서 제거할 수 없었다. 반면 ACL API 정보는 모든 Application이 동일한 최신 값을 사용해야 했다.

사내에 이미 Redis Cluster가 있어 별도의 Cache Infrastructure를 구축하기보다 이를 공용 Cache 저장소로 활용했다. 다만 JVM Memory에서 Network를 통해 접근하는 외부 저장소로 옮기면 Serialization과 장애 처리 같은 새 비용이 생긴다는 점도 함께 검토했다.

## Solution

기존 Business Logic의 `@Cacheable`, `@CacheEvict` 사용 방식과 Spring Cache Abstraction은 최대한 유지했다. Cache Provider를 바꾸면서 `CaffeineCacheManager`를 `RedisCacheManager`로 전환하고, 기존 Redis Cluster 환경에 연결했다. 실제 Cluster 구성과 접속 정보는 공개하지 않는다.

```text
Before: @Cacheable / @CacheEvict → CaffeineCacheManager → Instance별 Caffeine
After:  @Cacheable / @CacheEvict → RedisCacheManager    → 공용 Redis Cluster
```

### Cache Miss와 데이터 변경

조회 시 Redis에 값이 없다면 DB에서 원본 정보를 읽어 Cache에 저장하는 Cache-Aside 방식으로 동작한다.

```text
요청 → Redis 조회 → Hit: 저장된 정보 사용
                 └→ Miss: DB 조회 → Redis 저장 → 정보 사용
```

ACL API 정보가 변경되면 DB의 원본 값을 변경하고 관련 Cache Key를 `@CacheEvict`로 제거한다. 다음 조회에서는 Cache Miss가 발생해 DB의 최신 값을 다시 읽는다. 모든 Application이 같은 Redis Key를 사용하므로 각 Local Cache의 TTL 만료를 기다릴 필요가 없어졌다.

```text
ACL API 정보 변경 → DB 반영 → 관련 Redis Key 제거
다음 조회       → Redis Miss → DB 조회 → Redis에 다시 저장
```

## Redis 전환 시 고려한 운영 문제

### 1. Redis 장애와 Fail-Open

Redis는 원본 저장소가 아니라 DB 데이터를 빠르게 읽기 위한 Cache다. Redis 접근 예외가 Business Logic으로 그대로 전파되면 Cache 장애가 ACL 요청 실패로 이어질 수 있었다.

Spring Cache의 `CacheErrorHandler`를 재정의해 Cache 접근 오류를 기록하고, 조회 오류가 발생해도 DB에서 원본 정보를 읽도록 Fail-Open 방식을 적용했다.

```text
@Cacheable → Redis GET 오류 → CacheErrorHandler에서 기록
                            → DB 조회 → Business Logic 계속 수행
```

이 방식에는 비용이 있다. Redis 장애 동안 Cache Hit였을 요청도 DB로 향해 부하가 증가할 수 있다. 또한 변경 시 Cache Eviction이 실패하면 오래된 값이 남을 위험이 있으므로, 장애 처리와 최신성 확인은 함께 살펴봐야 한다. Redis가 Lock, Session, Rate Limit 또는 Business State를 저장하는 경우에는 동일한 Fail-Open 정책을 그대로 적용할 수 없다.

### 2. Serialization

Caffeine은 Java Object를 JVM Memory에 보관하지만 Redis에 값을 저장하려면 Serialization이 필요하다. JSON으로 저장하는 값에 `LocalDateTime` 같은 Java Time Type이 포함되면 기본 ObjectMapper 설정만으로 처리되지 않을 수 있다.

Redis Value용 ObjectMapper에 `JavaTimeModule`을 등록하고 날짜 표현 정책을 명시했다. 다음은 실제 회사 설정을 옮긴 코드가 아닌 개념 예시다.

```java
ObjectMapper mapper = new ObjectMapper();
mapper.registerModule(new JavaTimeModule());
mapper.disable(SerializationFeature.WRITE_DATES_AS_TIMESTAMPS);
```

### 3. Cache Key 정책

Spring Cache에서 Key를 지정하지 않으면 Method Parameter를 바탕으로 기본 Key가 생성된다. Business Identifier가 명확한 정보에는 Key를 명시해 Method Parameter가 추가되더라도 의도한 식별 기준을 유지하도록 했다.

```java
@Cacheable(cacheNames = "acl-api", key = "#apiType")
public ApiInformation getApiInformation(String apiType) {
    // DB에서 원본 정보 조회
}
```

이 코드는 일반화한 예시다. 실제 Cache 이름과 Method는 공개하지 않는다.

### 4. Transaction과 Cache 변경 시점

Redis CacheManager의 `transactionAware()` 설정을 사용하면 `put`, `evict`, `clear` 같은 Cache 변경을 DB Transaction의 Commit 이후로 미룰 수 있다. Rollback된 DB 변경이 Cache에 먼저 반영되는 상황을 줄이는 방법이다.

```text
DB 변경 → Commit → afterCommit → Cache 변경
```

하지만 같은 Transaction 안에서 Cache Miss 후 같은 값을 다시 조회한다면, 예약된 Cache Put이 아직 Redis에 반영되지 않아 DB 조회가 반복될 수 있다. Commit 이후 Redis 변경이 실패할 가능성도 검토해야 한다. 따라서 정합성, 동일 Transaction 내 재사용, 실제 Cache 반영 시점을 함께 고려해 설정 여부를 판단했다.

### 5. Eviction 중심의 갱신

데이터 변경 시 새 값을 Cache에 직접 쓰는 방법 대신 기존 Key를 제거했다. 다음 조회에서 Source of Truth인 DB의 값을 읽어 Cache를 다시 채우도록 한 것이다. 이 흐름은 DB 반영과 Cache Eviction의 순서가 중요하므로 Transaction 경계도 함께 검토했다.

Null Value Cache 정책과 Proxy를 통한 Cache Annotation 적용 위치도 Redis 전환 시 확인할 항목이었다.

## Result

서버마다 독립적으로 존재하던 ACL API 정보 Cache를 중앙으로 통합했다. 변경 시 관련 Redis Key를 제거해, Local Cache의 5분 TTL 동안 일부 Application이 이전 정보를 사용할 수 있던 구조를 개선했다. Redis 조회 장애 시에는 DB 원본 조회로 핵심 로직을 계속 수행할 수 있도록 했다.

이 프로젝트의 성과는 정량적인 Latency 개선보다 **중요 설정 데이터의 최신성과 운영 안정성**에 있다. 확인되지 않은 실행 시간이나 장애 횟수는 기재하지 않는다.

## Trade-offs

| 항목 | Caffeine | Redis |
| --- | --- | --- |
| Cache 범위 | Application별 Local | 여러 Application이 공유 |
| Network I/O | 없음 | 발생 |
| Serialization | Java Object를 메모리에 보관 | 외부 저장을 위한 정책 필요 |
| 장애 지점 | Application 내부 | Network와 Redis 추가 |
| 중앙 Eviction | 어려움 | 가능 |
| 운영 복잡도 | 낮음 | 상대적으로 높음 |

Redis가 언제나 더 나은 선택이라는 의미는 아니다. Instance마다 다른 Cache를 사용해도 문제가 없고 낮은 조회 지연이 우선이면 Local Cache가 적합할 수 있다. 이 사례에서는 변경 빈도보다 **변경 직후 모든 Application에 같은 값을 제공해야 하는 요구**가 더 중요했다.

## Lessons Learned

### 변경 빈도와 최신성 요구를 분리해 본다

거의 바뀌지 않는 데이터라도 오래된 값의 영향이 크다면 TTL만으로 충분하지 않을 수 있다. 변경 빈도, 허용 가능한 Stale Data 시간, 잘못된 데이터가 Business에 미치는 영향을 함께 평가해야 한다.

### Cache 저장소 변경은 Architecture 변경이다

Local Cache를 Redis로 바꾸면 Network, Serialization, Failure Handling, Transaction, Shared State를 새로 고려해야 한다. `CacheManager` 교체만으로 끝나는 작업이 아니었다.

### Cache의 역할에 맞게 장애 정책을 정한다

원본이 DB에 있었기에 Redis 조회 실패 시 DB로 돌아갈 수 있었다. Redis가 정확성에 필요한 상태를 보관한다면 다른 장애 정책이 필요하다. Spring Cache의 기본 Key 생성, Eviction, 오류 처리, Transaction 연동, Proxy 동작까지 이해하고 적용해야 한다.
