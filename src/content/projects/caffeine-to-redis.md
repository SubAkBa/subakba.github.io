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

Backend API·Open API·Batch의 ACL API URL Local Cache 불일치를 Redis 중앙 캐시로 해소하고, 전환 후 드러난 Batch 반복 조회와 Redis Cluster 장애 지연에 대응한 기록.

## 개선 흐름

<ol class="project-journey" aria-label="개선 단계">
  <li><strong>01 · 데이터 일관성</strong><span>Local Cache 불일치 → Redis 중앙 캐시</span></li>
  <li><strong>02 · Batch 캐시 효율</strong><span>Chunk 내 Cache Miss 반복 → Batch 설정 분리</span></li>
  <li><strong>03 · 장애 대응</strong><span>Redis 일부 노드 장애 → Timeout·Topology Refresh</span></li>
</ol>

## Stage 1. Local Cache 불일치 해결

ACL API URL 변경 후 Backend API가 이전 값을 사용해 ACL 등록에 실패한 장애. 세 모듈의 독립적인 Caffeine Local Cache를 Redis 중앙 캐시로 전환.

### 문제와 원인

Backend API·Open API·Batch가 동일한 DB 테이블의 ACL API URL을 각각 Caffeine Local Cache에 저장. 변경 빈도가 낮아 TTL은 5분으로 설정.

Open API의 공통 코드 수정 API로 URL을 변경하면 DB와 해당 요청의 캐시는 갱신되지만, 다른 애플리케이션 프로세스의 Local Cache에는 무효화가 전파되지 않는 구조.

```text
URL 변경 직후

Database          URL = B
Open API Cache    URL = B
Backend Cache     URL = A  ← 이전 값
Batch Cache       URL = A  ← 이전 값
```

각 캐시는 TTL 만료 후 최신 값을 다시 읽지만 생성 시점이 달라, 변경 후 **최대 5분의 URL 불일치 구간** 발생 가능.

실제 운영에서는 승인된 ACG/ACL 요청 티켓을 Backend API가 처리하는 동안 이전 URL을 조회. 잘못된 주소로 ACL API를 호출해 ACL 등록 실패와 서비스 간 네트워크 통신 실패로 연결.

장애 후 호출 로그에서 이전 URL로의 요청을 확인하고, DB의 최신 URL과 Backend API Local Cache의 값이 달랐던 구조를 분석.

### Redis 중앙 캐시 전환

- 세 모듈의 `CaffeineCacheManager`를 `RedisCacheManager`로 변경해 ACL API URL 캐시 공유
- Spring Cache `@Cacheable` 기반 Cache-Aside 적용. Cache Miss 시 DB 조회 후 Redis에 저장하고 TTL 5분 유지
- Open API에서 URL 변경 시 `@CacheEvict`로 해당 Cache Key 무효화. 이후 조회에서 DB의 새 값으로 재적재

```text
Backend API ──┐
Open API ─────┼── Redis: ACL API URL
Batch ────────┘
```

변경 빈도가 낮더라도 URL 변경 직후 애플리케이션 간 값의 일치가 필요하다는 판단에 따른 구조 변경. 모듈별 독립 Cache가 이전 URL을 유지하던 직접 원인 제거.

## Stage 2. Batch Cache Miss 원인 분석과 설정 분리

Redis 전환 후 Batch에서 동일 사원 정보 조회 SQL의 반복 실행 확인. 원인은 Chunk 트랜잭션 동안 지연된 Cache Put.

### `transactionAware()`와 Chunk 트랜잭션

DB 변경이 Rollback될 때 캐시만 먼저 변경되는 상황을 막기 위해 `RedisCacheManager`에 `transactionAware()` 적용. 다음 Java 코드는 설정의 핵심만 나타낸 공개용 예시.

```java
RedisCacheManager.builder(redisConnectionFactory)
    .transactionAware()
    .build();
```

이 설정은 트랜잭션 중 발생한 `put`, `evict`, `clear`를 Commit 이후에 실행. Spring Batch의 Chunk 기반 Step에서는 하나의 Chunk가 하나의 트랜잭션이므로, 첫 Item의 Cache Miss로 요청한 Put도 Chunk Commit까지 지연.

```text
Chunk 시작
  Item 1: 사원 조회 → Cache Miss → DB 조회 → Cache Put 예약
  Item 2: 같은 사원 조회 → Cache Miss → DB 재조회
Chunk Commit → 예약된 Cache Put 실행
```

트랜잭션 시작 전에 Redis에 있던 값은 Cache Hit. 반면 **해당 Chunk에서 처음 읽은 값은 Commit 전까지 같은 Chunk에서 재사용 불가**. 실제 반복 조회는 Chunk 기반 Step에서 발견. Tasklet도 하나의 트랜잭션 안에서 같은 Key를 반복 조회한다면 동일한 구조적 문제 가능.

### Batch 설정 분리

사원 정보는 이 Batch의 처리 중 직접 수정하지 않고 일 배치로 다른 시스템에서 동기화하는 데이터. Chunk 내 재사용을 우선해 Batch의 `transactionAware()` 제거.

이 변경은 Cache Put뿐 아니라 같은 CacheManager의 Evict·Clear에도 Commit 이후 지연을 적용하지 않는 선택. 사원 정보 동기화와 Cache 무효화 경로가 DB 변경 시점과 어떻게 맞물리는지 별도 확인 필요.

```text
변경 전: Cache Miss → DB 조회 → Commit 후 Redis 반영 → Chunk 내 반복 Miss
변경 후: Cache Miss → DB 조회 → 즉시 Redis 반영 → 동일 Key 재조회 시 Hit 가능
```

모든 모듈에 동일한 CacheManager 설정을 적용하지 않고 트랜잭션 범위와 데이터 변경 특성에 맞춰 설정 분리.

## Stage 3. Redis Cluster 일부 노드 장애 대응

Redis Cluster 일부 노드 장애 시 Backend API 요청이 로딩 상태로 지연. Cache 예외 처리에 더해 Command Timeout과 Cluster Topology Refresh 적용.

### `CacheErrorHandler`의 역할과 한계

Redis를 성능 최적화용 Cache로 사용하므로 Cache GET 실패 시 원본 메서드가 DB에서 읽도록 `CacheErrorHandler` 구성. `@Cacheable`의 Redis GET이 예외로 끝나면 Handler를 거쳐 DB 조회 가능. 그러나 장애 노드의 응답을 기다리는 동안에는 Handler가 호출되지 않으므로 **예외 처리만으로 요청 지연을 줄일 수 없는 구조**.

또한 `transactionAware()`로 예약된 Cache Put·Evict·Clear는 DB Commit 이후 콜백에서 실제 실행. 이 시점의 Redis 오류는 캐시 호출 당시의 `CacheErrorHandler`를 거치지 않을 수 있음. 따라서 GET 실패 시의 DB 조회 경로를 모든 캐시 변경 실패에 대한 Fail-Open 보장으로 확대해 해석하지 않도록 구분.

다음 Java 코드는 Cache 연산의 예외를 기록하고 전파하지 않는 처리의 공개용 예시.

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
                "Cache PUT error: cache={}, key={}",
                cache.getName(),
                key,
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

```text
Redis GET 실패     → CacheErrorHandler → 원본 메서드의 DB 조회
Redis 응답 대기    → Command Timeout으로 대기 시간 제한 필요
Commit 이후 Put   → 지연된 캐시 연산의 오류 처리 별도 고려 필요
```

### 로컬 Cluster 장애 재현

운영 장애 이후 Redis Node 6개로 `3 Master + 3 Replica` 로컬 Cluster 구성. 애플리케이션에서 지속적으로 Redis 요청을 보내며 Master Node 하나를 종료해 장애 상황 재현.

- Master 종료 후 연결 실패, Replica의 Master 승격 및 Failover 확인
- 장애 직후 일부 Redis 요청 실패 후 정상화 확인
- Lettuce의 Topology Refresh와 Periodic Refresh에 따른 Cluster 정보 갱신 확인
- Refresh 미적용 로컬 테스트에서 기존 Cluster 정보를 기준으로 연결을 시도하는 동작 관찰
- Refresh 적용 로컬 테스트에서 최신 Topology 조회와 승격된 Master·변경된 Slot 정보의 반영 확인

두 구성의 차이는 로컬 재현에서 관찰한 범위. Refresh 미적용 상태에서도 Lettuce의 `MOVED`·`ASK` 리다이렉션은 동작할 수 있으므로 복구 불가능으로 일반화하지 않음. 테스트에서 **Server의 Failover 구성과 Client의 변경된 Topology 인식이 함께 중요**함을 확인.

### Lettuce 설정

Backend API가 장애 노드의 Redis 응답을 장시간 기다리지 않도록 Command Timeout 1초 설정. 장애나 Cluster 구성 변경을 Client가 인식하도록 Adaptive·Periodic Topology Refresh 적용. 다음 Java 코드는 적용 옵션을 나타낸 공개용 예시.

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

| 옵션 | 적용 목적 |
| --- | --- |
| `enableAllAdaptiveRefreshTriggers()` | `MOVED`, `ASK`, 지속적인 재연결 실패 등 변경 신호 발생 시 정기 주기를 기다리지 않고 Topology 갱신 |
| `adaptiveRefreshTriggersTimeout(60s)` | 다수 요청이 Refresh를 연달아 발생시키지 않도록 Adaptive Refresh 빈도 제한 |
| `enablePeriodicRefresh(60s)` | Trigger와 별개로 60초마다 Topology를 다시 조회해 변경 상태 보정 |
| `dynamicRefreshSources(true)` | Lettuce의 기본값 `true`를 명시적으로 유지. Seed Node 외에 발견된 Cluster Node도 Refresh Source로 사용 |

Topology Refresh는 변경된 Cluster 정보의 인식, Command Timeout은 Redis 명령 대기 시간의 제한, `CacheErrorHandler`는 호출 중 발생한 Cache 예외의 처리 담당. 로컬 장애 재현에서 Failover와 Refresh 동작 확인.

## 결과

- Backend API·Open API·Batch의 ACL API URL 캐시 공유 및 변경 시 해당 Key 무효화
- 기존 ACL 등록 장애의 직접 원인이었던 프로세스별 Local Cache 불일치 구조 제거
- Batch의 Chunk 내 반복 Cache Miss 원인을 `transactionAware()`의 Commit 이후 Put으로 확인하고 Batch 설정 분리
- Redis Cluster 장애를 로컬에서 재현해 Failover 및 Topology Refresh 동작 확인. Command Timeout 1초와 Adaptive·Periodic Refresh 적용

### 검증 범위

운영 장애의 이전 URL 호출, Batch의 반복 SQL, 로컬 Cluster의 Failover 및 Refresh 동작까지 확인. 전환 후 장애 재발 집계 기간·기준, Batch 설정 변경 후 Cache Hit·SQL 변화, 운영 API 지연 변화의 정량 자료는 확인되지 않아 수치 결과로 제시하지 않음.
