---
title: "Caffeine Local Cache → Redis 중앙 캐시 전환"
company: "N Tech Service"
category: "Cache Architecture"
summary: "ACL URL 캐시 불일치 해결부터 Batch Cache Miss와 Redis Cluster 장애 대응까지 개선한 과정"
skills:
  - Java
  - Spring Boot
  - Spring Cache
  - Caffeine
  - Redis
  - Lettuce
featured: true
order: 2
draft: false
---

공통 코드의 Local Cache 불일치에서 시작해 Redis 전환, Batch 캐시 동작 수정, Cluster 장애 대응까지 세 단계로 개선.

## 개선 흐름

<ol class="project-journey" aria-label="개선 단계">
  <li><strong>01 · 데이터 일관성</strong><span>Local Cache 불일치 → Redis 중앙 캐시</span></li>
  <li><strong>02 · Batch 캐시 효율</strong><span>Chunk 내 Cache Miss 반복 → Batch 설정 분리</span></li>
  <li><strong>03 · 장애 대응</strong><span>Redis 일부 노드 장애 → Timeout·Topology Refresh</span></li>
</ol>

아래 탭에서 각 단계의 문제, 원인, 적용 내용과 검증 과정 확인 가능.

## Stage 1. Local Cache 불일치 해결

세 애플리케이션의 Local Cache에서 서로 다른 ACL API URL 반환. Redis 중앙 캐시로 전환하고 URL 변경 시 해당 Cache Key 무효화.

### 모듈별 Local Cache 구조

Backend API, Open API, Batch 모듈에서 ACL API URL과 같은 공통 코드 데이터 조회에 각각 Caffeine Local Cache 사용.

운영상 변경 빈도가 매우 낮은 ACL API URL을 각 모듈에서 DB 조회 후 5분 동안 Local Cache에 저장.

```text
                   ┌─────────────────┐
                   │    Database     │
                   │ ACL API URL = A │
                   └────────┬────────┘
                            │
             ┌──────────────┼──────────────┐
             │              │              │
             ▼              ▼              ▼
       Backend API       Open API        Batch
       ┌─────────┐      ┌─────────┐     ┌─────────┐
       │Caffeine │      │Caffeine │     │Caffeine │
       │ URL = A │      │ URL = A │     │ URL = A │
       └─────────┘      └─────────┘     └─────────┘
```

각 모듈이 동일한 DB 테이블을 조회하지만, Caffeine Cache는 애플리케이션 프로세스 내부에 존재해 서로 독립적인 캐시 데이터를 보유.

### ACL API URL 변경 후 캐시 불일치 발생

Open API에 ACL API 관련 공통 코드 데이터 수정 API 존재.

Open API를 통한 ACL API URL 변경 시 DB에는 새 URL이 정상 반영. 반면 캐시 무효화는 해당 요청에서 지정한 캐시에만 적용되어 다른 애플리케이션 프로세스의 Local Cache까지 전파되지 않는 구조.

```text
1. Open API를 통해 ACL API URL 변경

  Database
  URL = A  →  URL = B


2. 각 애플리케이션의 Local Cache 상태

  Backend API        Open API          Batch
  ┌─────────┐       ┌─────────┐       ┌─────────┐
  │ URL = A │       │ URL = B │       │ URL = A │
  └─────────┘       └─────────┘       └─────────┘
       ↑                                  ↑
    이전 데이터                         이전 데이터
```

각 캐시는 TTL 5분 만료 후 DB의 최신 데이터를 다시 조회하므로 최종적으로 값이 일치.

모듈마다 캐시 생성 시점이 달라 ACL API URL 변경 후 **최대 5분 동안 서로 다른 URL을 사용하는 불일치 구간** 발생 가능.

### 캐시 불일치가 실제 장애로 연결

실제 운영 환경에서 ACL API URL 변경 후 Backend API의 Local Cache에 이전 URL이 남은 상태로 ACG/ACL 요청 티켓이 처리되며 장애 발생.

```text
ACG/ACL 요청 티켓 진행
       ↓
승인 담당자 승인
       ↓
Backend API에서 ACL 등록 처리
       ↓
Local Cache에서 ACL API URL 조회
       ↓
이전 ACL API URL 반환
       ↓
잘못된 주소로 ACL API 호출
       ↓
ACL 등록 실패
       ↓
서비스 간 네트워크 통신 실패
```

DB에는 변경된 ACL API URL이 정상 저장되었지만, Backend API는 DB 조회 없이 자신의 Local Cache에 남은 이전 URL 사용.

결과적으로 **공통 데이터를 여러 애플리케이션의 독립적인 Local Cache로 관리하면서 발생한 데이터 불일치가 실제 서비스 장애로 연결.**

### 원인 분석

장애 발생 후 호출 로그와 캐시 구조에서 확인한 원인은 다음과 같음.

- Backend API, Open API, Batch가 동일한 DB 데이터를 각각 Caffeine Local Cache에 저장
- 애플리케이션별 Local Cache가 서로 독립적으로 관리되어 캐시 데이터 불일치 가능
- Open API를 통한 데이터 변경 시 다른 애플리케이션의 Local Cache까지 즉시 무효화할 수 없는 구조
- TTL 5분을 통해 최종적으로 데이터가 갱신되지만, TTL 만료 전까지 최대 5분의 불일치 구간 존재
- 해당 구간에서 Backend API가 이전 ACL API URL을 사용하면서 실제 ACL 등록 장애 발생

운영상 변경 빈도가 매우 낮아 Local Cache만으로도 충분하다고 판단하기 쉬운 ACL API URL.

이번 장애를 통해 **낮은 변경 빈도와 데이터 불일치 허용 여부는 별개의 문제**임을 확인.

여러 애플리케이션이 동일한 데이터를 사용하고 변경 직후에도 같은 값을 사용해야 하는 경우, 프로세스별 Local Cache 대신 애플리케이션 간 데이터를 공유하는 캐시 구조 필요.

이에 Backend API, Open API, Batch가 하나의 캐시 데이터를 공유하도록 Caffeine Local Cache를 Redis 기반 중앙 캐시로 전환.

```text
기존

Backend API        Open API          Batch
┌─────────┐       ┌─────────┐       ┌─────────┐
│Caffeine │       │Caffeine │       │Caffeine │
└─────────┘       └─────────┘       └─────────┘
    ↑                 ↑                 ↑
    └──────── 각각 독립적인 캐시 ────────┘


변경

Backend API ──┐
Open API ─────┼──────▶ Redis
Batch ────────┘          │
                        ▼
                   ACL API URL
```

Redis 중앙 캐시에서 각 애플리케이션이 동일한 데이터를 조회하도록 변경. ACL API URL 변경 시 해당 Redis Cache Key를 제거해 다음 조회부터 변경된 데이터를 사용하도록 구성.

### 해결: Redis 중앙 캐시 전환

- 세 모듈의 `CaffeineCacheManager`를 `RedisCacheManager`로 전환하여 동일한 ACL Endpoint 캐시 공유
- Spring Cache의 `@Cacheable` 기반 Cache-Aside 적용
- Redis Cache Miss 시 각 애플리케이션이 접근하는 DB에서 조회 후 Redis에 적재하고 TTL 5분 유지
- ACL Endpoint 변경 시 `@CacheEvict`로 해당 Endpoint의 Cache Key만 선택적으로 무효화
- 다음 조회에서 DB의 최신 값으로 Redis 캐시 재적재

## Stage 2. Batch의 반복 Cache Miss 해결

Redis 전환 후 Batch에서 동일한 사원 정보의 반복 조회 발생. Chunk 내 Cache Put을 Commit까지 지연한 `transactionAware()`를 Batch 설정에서 제거.

Redis 전환 과정에서 DB 트랜잭션과 캐시 데이터의 정합성을 고려해 `RedisCacheManager`에 `transactionAware()` 적용.

```java
RedisCacheManager.builder(redisConnectionFactory)
    .transactionAware()
    .build();
```

DB 트랜잭션 안에서 데이터와 캐시를 함께 변경할 때, 캐시 변경 후 DB 트랜잭션이 Rollback되면 DB와 캐시 간 데이터 불일치 가능.

이를 방지하기 위해 `transactionAware()`를 적용하고 `put`, `evict`, `clear` 등의 캐시 변경 연산을 DB 트랜잭션 Commit 이후 수행하도록 구성.

실제 환경에 적용한 뒤 Batch와 Backend API에서 서로 다른 문제 발생.

### 문제 상황

Redis Cache 적용 후 Batch 로그에서 동일한 사원 정보 조회 SQL의 반복 실행 확인.

사번·이름·부서 등을 포함한 사원 정보는 여러 Item에서 동일하게 조회될 수 있어, 반복적인 DB 조회를 줄이기 위해 `@Cacheable` 적용.

그러나 동일한 사원을 조회할 때 Cache Hit 없이 동일 SQL이 반복 실행되는 상태.

### 원인 분석

Spring Batch의 Chunk 기반 Step은 기본적으로 하나의 Chunk를 하나의 트랜잭션으로 처리.

`transactionAware()` 적용 CacheManager에서는 트랜잭션 안에서 발생한 Cache Put을 즉시 Redis에 반영하지 않고 Commit 이후로 지연.

따라서 하나의 Chunk에서 동일한 사원 정보를 반복 조회할 때 다음과 같은 동작 발생.

```text
Chunk Transaction 시작

Item 1
→ 사원 10001 조회
→ Cache Miss
→ DB 조회
→ Cache Put 요청
→ transactionAware()에 의해 Put 지연

Item 2
→ 사원 10001 조회
→ Redis에 아직 Cache 없음
→ Cache Miss
→ DB 조회
→ Cache Put 요청

Item 3
→ 사원 10001 조회
→ Redis에 아직 Cache 없음
→ Cache Miss
→ DB 조회

...

Chunk Commit
→ 지연되어 있던 Cache Put 수행
```

첫 번째 Item에서 사원 정보 조회 후 Cache Put을 요청해도 실제 Redis 반영은 Chunk Commit까지 지연.

동일 Chunk의 다음 Item에서 앞선 조회 결과를 Cache로 활용하지 못해 DB 재조회.

트랜잭션 시작 전 Redis에 존재한 데이터는 정상적으로 Cache Hit. 반면 **해당 Chunk에서 처음 Cache Miss로 조회한 데이터는 Chunk 종료 전까지 동일 트랜잭션에서 재사용 불가.**

### Tasklet 검토

실제 문제는 Chunk 기반 Step에서 발견.

원인 분석 과정에서 Tasklet도 트랜잭션 내부에서 동일한 Cache Key를 반복 조회한다면 같은 문제가 발생할 수 있음을 확인.

```text
Tasklet Transaction 시작

Cache Miss
→ DB 조회
→ Cache Put 예약

동일 Key 재조회
→ Cache Miss
→ DB 재조회

Tasklet Transaction Commit
→ Cache Put 수행
```

문제의 핵심은 **하나의 트랜잭션이 유지되는 동안 `transactionAware()`에 의해 Cache Put이 지연되는 구조**임을 확인.

### 해결

Batch에서 캐싱하는 사원 정보의 데이터 특성 재검토.

사원 정보는 Batch 처리 중 직접 수정하지 않고 일 배치를 통해 다른 시스템에서 동기화하는 데이터. 변경 빈도가 낮아 Batch 처리 트랜잭션과 Cache Put의 원자성을 강하게 보장할 필요성도 낮음.

반면 하나의 Chunk에서 동일한 사원 정보를 반복 조회할 수 있으므로 Cache Miss 이후 조회 결과를 즉시 저장하고 다음 Item에서 재사용하는 것이 우선.

따라서 Batch 설정에서 `transactionAware()` 제거.

```text
transactionAware() 적용

Cache Miss
→ DB 조회
→ Cache Put 예약
→ 동일 Chunk에서 Cache Miss 반복
→ Chunk Commit
→ Redis 반영


transactionAware() 제거

Cache Miss
→ DB 조회
→ Redis 즉시 반영
→ 동일 Key 재조회
→ Cache Hit
```

모든 모듈에 동일한 Cache 설정을 적용하지 않고 **모듈별 트랜잭션 범위와 데이터 변경 특성에 맞춰 CacheManager 설정을 분리.**

## Stage 3. Redis Cluster 일부 노드 장애 대응

Redis 일부 노드 장애에서 Backend API 요청 지연 발생. Command Timeout을 1초로 제한하고 로컬 장애 재현을 거쳐 Adaptive·Periodic Topology Refresh 적용.

### 장애 대응을 위한 Fail-Open 구성

Redis 중앙 Cache 장애가 Backend API 전체 장애로 전파되지 않도록 `CacheErrorHandler` 구성.

Cache 조회 중 Redis 장애가 발생하면 예외를 비즈니스 로직으로 전파하지 않고 로그만 기록하도록 설정.

```java
@Override
public CacheErrorHandler errorHandler() {
    return new CacheErrorHandler() {
        @Override
        public void handleCacheGetError(
                RuntimeException exception,
                Cache cache,
                Object key
        ) {
            log.error(
                "Cache GET error: cache={}, key={}",
                cache.getName(),
                key,
                exception
            );
        }

        @Override
        public void handleCachePutError(
                RuntimeException exception,
                Cache cache,
                Object key,
                Object value
        ) {
            log.error(
                "Cache PUT error: cache={}, key={}, value={}",
                cache.getName(),
                key,
                value,
                exception
            );
        }

        @Override
        public void handleCacheEvictError(
                RuntimeException exception,
                Cache cache,
                Object key
        ) {
            log.error(
                "Cache EVICT error: cache={}, key={}",
                cache.getName(),
                key,
                exception
            );
        }

        @Override
        public void handleCacheClearError(
                RuntimeException exception,
                Cache cache
        ) {
            log.error(
                "Cache CLEAR error: cache={}",
                cache.getName(),
                exception
            );
        }
    };
}
```

의도한 동작은 Redis를 사용할 수 없는 상황에서도 Cache를 우회해 기존 비즈니스 로직을 계속 수행하는 것.

`@Cacheable` 조회에서는 Redis GET 예외를 `handleCacheGetError()`에서 처리한 뒤 원본 메서드를 실행해 DB 조회 가능.

```text
Redis 정상

Request
→ Redis GET
→ Cache Hit
→ Response


Redis GET 실패

Request
→ Redis GET
→ Exception
→ CacheErrorHandler
→ 예외 전파하지 않음
→ DB 조회
→ 원본 메서드 결과 반환
```

Redis는 성능 최적화를 위한 Cache이므로 **Redis GET 실패 시 DB 조회로 이어지는 Fail-Open 전략** 적용. 이후 발생하는 Cache Put 실패는 별도 고려 필요.

### 실제 환경에서 발생한 문제

실제 환경에서 Redis Cluster 일부 노드 장애 발생. 버튼 클릭·데이터 저장 요청이 정상적으로 완료되지 않고 로딩 상태 지속.

`CacheErrorHandler`의 예외 처리를 통해 Redis 장애 상황에서도 비즈니스 로직은 정상 수행될 것으로 예상.

그러나 실제 요청의 Redis 접근 과정은 즉시 실패하지 않았고, Redis Client의 연결 및 명령 Timeout 등의 영향으로 지연.

`CacheErrorHandler`는 **Redis 접근 과정에서 최종 예외가 발생한 이후** 호출되므로 Redis 응답 대기 시간 자체는 제거 불가.

```text
Request
   ↓
Redis 접근
   ↓
장애 노드 응답 대기
   ↓
Timeout
   ↓
Exception
   ↓
CacheErrorHandler
   ↓
예외 무시
   ↓
비즈니스 로직 계속 수행
```

따라서 예외 처리만으로는 Redis 장애가 Backend API의 응답 지연으로 전파되는 현상을 막기에 불충분.

### `transactionAware()`와 Cache 변경 시점

`transactionAware()` 적용으로 `put`, `evict`, `clear` 등의 Cache 변경 연산은 DB 트랜잭션 중 즉시 Redis에 전달되지 않고 Commit 이후 수행.

예를 들어 `@CachePut`이 적용된 데이터 저장 로직에서는 다음과 같은 흐름 발생 가능.

```text
@Transactional
@CachePut
데이터 저장
     ↓
DB INSERT
     ↓
Cache Put 예약
     ↓
Transaction Commit
     ↓
Redis PUT 수행
     ↓
Redis 장애 노드 응답 대기
     ↓
Timeout / Exception
     ↓
afterCommit 콜백에서 예외 발생
```

이 구조에서는 Cache 변경 요청 시점과 실제 Redis 접근 시점 분리.

실제 Redis 연산은 `CacheErrorHandler`가 감싼 `put` 호출의 반환 뒤 Commit 이후 콜백에서 실행. 이 시점의 실패는 `CacheErrorHandler`가 처리하지 못할 가능성 존재. DB Commit이 끝난 뒤에도 요청에는 예외나 지연이 나타날 수 있어, 조회 실패의 Fail-Open과 트랜잭션 이후 캐시 변경 실패를 구분할 필요.

### 원인 분석

Redis 장애 대응 구조 재검토 시 구분한 세 가지 역할.

```text
CacheErrorHandler
→ Spring Cache가 직접 실행한 Redis 연산의 예외 처리
→ Cache GET 실패 시 DB 조회 경로 유지
→ transactionAware()의 afterCommit 콜백 오류는 별도 고려 필요

Command Timeout
→ 장애가 발생한 Redis 응답을 기다리는 최대 시간 제한
→ 응답 지연 제어

Cluster Topology Refresh
→ Redis Cluster의 변경된 노드 상태를 빠르게 인식
→ 장애 노드로의 지속적인 접근 최소화
```

`CacheErrorHandler`만으로는 Redis 장애 상황에서 Backend API의 가용성 보호에 불충분.

**예외 처리와 함께 Redis Client의 장애 감지 및 응답 대기 제한**도 설계 대상. 특히 트랜잭션 이후로 지연된 캐시 쓰기는 일반적인 Cache 예외 처리 경로와 다를 가능성 존재.

### 해결

Redis Cluster 일부 노드 장애 시 Backend API 요청의 Redis 응답 대기 시간을 제한하기 위해 Lettuce Command Timeout 1초 설정.

### Redis Cluster 장애 재현 및 Topology Refresh 검증

실제 환경의 Redis Cluster 일부 노드 장애 이후, Redis Client의 장애 및 Failover 동작을 확인하기 위해 로컬 Redis Cluster를 직접 구성해 테스트.

Redis Node 6개를 실행해 `3 Master + 3 Replica` 구조의 Cluster 구성.

```text
Local Redis Cluster

Master 1 ───── Replica 1
Master 2 ───── Replica 2
Master 3 ───── Replica 3
```

애플리케이션에서 Redis에 지속적으로 요청을 보내는 동안 Master Node 하나를 종료해 장애 상황 재현.

```text
Master 1 ───── Replica 1
   X               │
 장애 발생           │
                   ▼
              Master 승격
```

로그와 Cluster 상태를 통해 확인한 과정.

- Master Node 종료 후 연결 실패 발생
- Replica Node의 Master 승격 및 Failover 확인
- 장애 직후 일부 Redis 요청 실패 후 정상화 확인
- Lettuce의 Topology Refresh 동작 확인
- Periodic Refresh에 따른 주기적인 Cluster 정보 갱신 확인

테스트에서 **Client의 변경된 Redis Cluster 구성 인식이 장애 복구에 중요함**을 확인.

Topology Refresh 미적용 시 Client는 기존 Cluster 정보를 기준으로 연결을 시도해 Failover 이후 변경된 Node 역할과 Slot 정보의 반영에 한계.

Topology Refresh 활성화 후에는 최신 Topology 재조회로 승격된 Master와 변경된 Slot 정보를 반영하고 해당 Node를 요청 대상으로 사용할 수 있음을 확인.

```text
Topology Refresh 미적용

초기 Cluster 정보
      ↓
Master 장애 / Cluster 변경
      ↓
기존에 알고 있던 Node 정보 기반으로 연결
      ↓
변경된 Cluster 구성 반영에 한계


Topology Refresh 적용

초기 Cluster 정보
      ↓
Master 장애 / Cluster 변경
      ↓
Topology Refresh
      ↓
최신 Cluster 정보 조회
      ↓
승격된 Master와 변경된 Slot 정보 반영
      ↓
변경된 Cluster 구성으로 요청
```

이 검증을 바탕으로 실제 애플리케이션에 Adaptive Refresh와 Periodic Refresh를 함께 적용.

```java
ClusterTopologyRefreshOptions topologyRefreshOptions =
    ClusterTopologyRefreshOptions.builder()
        .enableAllAdaptiveRefreshTriggers()
        .adaptiveRefreshTriggersTimeout(
            Duration.ofSeconds(60)
        )
        .enablePeriodicRefresh(
            Duration.ofSeconds(60)
        )
        .dynamicRefreshSources(true)
        .build();
```

각 옵션의 적용 목적은 다음과 같음.

- `enableAllAdaptiveRefreshTriggers()`: `MOVED`, `ASK`, 지속적인 재연결 실패 등 Cluster 변경 이벤트 발생 시 정기 갱신 주기를 기다리지 않고 Topology Refresh 수행. 장애나 Failover 후 변경된 구성의 빠른 인식을 위한 설정
- `adaptiveRefreshTriggersTimeout(60s)`: 다수의 요청에 따른 Adaptive Refresh의 과도한 발생을 막기 위해 갱신 빈도를 60초 간격으로 제한. Redis와 Client의 추가 부하 방지
- `enablePeriodicRefresh(60s)`: Trigger 발생 여부와 관계없이 60초마다 Cluster Topology 갱신. Adaptive Refresh가 감지하지 못한 상태 변화의 주기적 보정
- `dynamicRefreshSources(true)`: Seed Node 외에도 Topology 조회에서 발견한 Cluster Node를 이후 갱신의 Source로 사용. 특정 Seed Node 장애 시 다른 Node를 통한 Cluster 정보 조회

```text
              Redis Cluster
                    │
          ┌─────────┴─────────┐
          │                   │
  장애/변경 이벤트 발생        60초 경과
          │                   │
          ▼                   ▼
 Adaptive Refresh      Periodic Refresh
          │                   │
          └─────────┬─────────┘
                    ▼
            최신 Topology 조회
                    │
                    ▼
           Client Cluster 정보 갱신
```

**운영 장애를 로컬 Redis Cluster에서 재현하고 Failover와 Topology Refresh 동작을 직접 확인한 뒤 필요한 설정 적용.**

Redis Cluster 사용 시 Server의 Failover 구성과 함께 **Client의 변경된 Cluster Topology 인식 및 반영 속도도 장애 대응의 핵심 요소**임을 확인.

### Cache 장애와 API 장애의 분리

Topology Refresh와 함께 Redis GET 실패가 Backend API 전체 장애로 확산되지 않도록 Cache 접근 실패 시 Fail-Open 전략 유지.

```text
Redis 정상
→ Cache Hit
→ Cache 데이터 사용

Redis GET 실패
→ CacheErrorHandler에서 예외 처리
→ DB 조회 및 기존 비즈니스 로직 수행
```

각 설정의 역할 구분.

```text
Topology Refresh
→ Redis Cluster의 변경된 상태를 빠르게 인식

Command Timeout
→ Redis 응답을 기다리는 최대 시간 제한

CacheErrorHandler
→ 직접 실행한 Cache 연산의 예외 처리
→ GET 실패 시 DB 조회 경로 유지
```

Redis는 Backend API의 원본 데이터 저장소가 아닌 성능 최적화용 Cache. Redis GET 실패 시에도 DB를 통해 핵심 조회 기능을 계속 제공하도록 구성. 다만 `transactionAware()`로 Commit 이후 실행되는 Cache Put·Evict·Clear의 실패는 `CacheErrorHandler`만으로 처리하기 어려워 별도 고려 필요.

## 결과

- Batch, Open API, Backend API 간 ACL Endpoint 캐시 일관성 확보 및 캐시 운영 구조 단순화
- 전환 이후 **기존 Local Cache 데이터 불일치로 발생하던 ACL 등록·네트워크 통신 장애 0건 유지**
- Batch에서는 `transactionAware()`를 제거하여 동일 Chunk의 Cache Miss 이후 조회 결과를 다시 활용하도록 변경
- Redis Cluster 장애를 로컬에서 재현하여 Failover와 Topology Refresh 동작을 확인하고, Command Timeout 1초 및 Adaptive·Periodic Refresh 적용
