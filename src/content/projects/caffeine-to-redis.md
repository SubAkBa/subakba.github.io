---
title: "Caffeine Local Cache → Redis 중앙 캐시 전환"
company: "N Tech Service"
category: "Cache Architecture"
summary: "모듈별 ACL Endpoint 캐시 불일치로 발생한 ACL 등록·네트워크 통신 장애를 Redis 중앙 캐시로 해결"
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

## 문제와 원인

- Batch, Open API, Backend API가 각각 Caffeine Local Cache에 ACL API Endpoint 정보를 보관하는 구조와 5분 TTL 분석
- 모듈별 캐시 불일치로 잘못된 Endpoint 호출 → ACL 미등록 → 서비스 간 네트워크 통신 실패로 이어지는 장애 원인 확인
- 변경 빈도가 낮은 데이터라도 모듈 간 일관성이 필요하다고 판단하고, 사내 Redis Cluster를 공용 캐시로 활용하는 방향 결정

## 중앙 캐시 전환

- 세 모듈의 `CaffeineCacheManager`를 `RedisCacheManager`로 전환하여 동일한 ACL Endpoint 캐시 공유
- Spring Cache의 `@Cacheable` 기반 Cache-Aside 적용
- Redis Cache Miss 시 각 애플리케이션이 접근하는 DB에서 조회 후 Redis에 적재하고 TTL 5분 유지
- ACL Endpoint 변경 시 `@CacheEvict`로 해당 Endpoint의 Cache Key만 선택적으로 무효화
- 다음 조회에서 DB의 최신 값으로 Redis 캐시 재적재

## Redis 장애 대응

- Redis 조회 오류 발생 시 Spring Cache `CacheErrorHandler`에서 Cache Miss로 처리해 DB 조회 경로로 전환
- 캐시 조회 장애의 서비스 전파 영향 최소화
- Lettuce의 Adaptive·60초 주기 Topology Refresh와 Dynamic Refresh Sources 적용으로 Redis Cluster 노드·토폴로지 변경 대응
- 연결 해제 시 실행 불가 명령 거부 및 Command Timeout 1초 적용으로 Redis 장애·응답 지연 시 대기 시간 제한

## 결과

- Batch, Open API, Backend API 간 ACL Endpoint 캐시 일관성 확보 및 캐시 운영 구조 단순화
- 전환 이후 **기존 Local Cache 데이터 불일치로 발생하던 ACL 등록·네트워크 통신 장애 0건 유지**
