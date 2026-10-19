---
title: "Open API 성능 측정을 위한 부하 테스트 환경 구축 및 안정성 개선"
company: "N Tech Service"
period: "2025.06 ~ 2025.07, 2025.09"
category: "Performance Testing"
summary: "웹 기반 부하 테스트 환경 구축에서 실행 중인 프로세스 종료와 다중 서버의 중복 실행 방지까지 개선한 과정"
skills:
  - Java
  - Spring Boot
  - Gatling
  - Gatling Java DSL
  - Redis
  - React
  - WebClient
featured: true
order: 3
draft: false
---

## 작업 배경

Open API의 처리 가능한 요청량을 확인하고 Rate Limit 정책 수립에 활용할 부하 테스트 환경 필요. 기존에는 개발자가 테스트 코드를 직접 작성·실행해야 해 조건을 바꿔 반복하거나 운영 담당자가 사용하기 어려웠음.

JMeter, k6, Gatling 등을 검토하고 Java DSL 기반 시나리오 작성과 기존 Java/Spring Boot 시스템과의 연계가 용이한 Gatling 선정. 웹에서 조건을 설정해 테스트를 실행하는 환경을 구축한 뒤, 실제 운영 구조에서 발견한 문제를 개선.

## 개선 흐름

<ol class="project-journey" aria-label="부하 테스트 환경 개선 단계">
  <li><strong>01 · 환경 구축</strong><span>수동 실행 → 웹에서 조건 설정·실행</span></li>
  <li><strong>02 · 강제 종료</strong><span>실행 서버 탐색 → 프로세스 검증·종료</span></li>
  <li><strong>03 · 중복 실행 방지</strong><span>서버별 로컬 상태 → Redis 실행권 공유</span></li>
</ol>

아래 탭에서 각 단계의 문제와 해결 과정을 확인 가능.

## Stage 1. 부하 테스트 환경 구축

웹에서 요청 조건과 부하 패턴을 설정하고, 별도 Gatling 프로세스로 Open API에 테스트 트래픽 생성.

### 반복 테스트를 위한 웹 환경

테스트마다 코드를 수정하지 않도록 React 화면에서 URL·HTTP Method·Header·Parameter·Body와 사용자 수·투입 시간·부하 지속 시간·Injection 방식을 설정.

Gatling Java DSL로 시나리오를 구성하고 별도 프로젝트를 JAR로 패키징. Spring Boot API가 입력값을 System Property로 전달하며 `ProcessBuilder`로 Gatling JAR 실행.

```text
React 화면 → Spring Boot API → ProcessBuilder + System Property
                                      ↓
                                  Gatling JAR → Open API
```

### 다양한 트래픽 패턴

| Injection 방식 | 테스트 패턴 |
| --- | --- |
| `atOnceUsers` | 사용자 즉시 투입 |
| `rampUsers` | 일정 시간 동안 사용자 수 점진적 증가 |
| `constantUsersPerSec` | 일정한 초당 사용자 투입 |
| `stressPeakUsers` | 순간적인 Peak 트래픽 |

입력값에 따라 시나리오와 Injection Profile을 동적으로 구성해 동일한 화면에서 조건을 변경하며 반복 테스트.

### 요청 처리와 테스트 실행 분리

Gatling 실행은 별도 Thread에서 처리하고 테스트 시작 후 HTTP 응답 반환. 수 분 이상 지속될 수 있는 부하 테스트가 API 요청 Thread를 점유하지 않도록 구성.

Backend API의 요청 처리와 별도 Gatling 프로세스의 실행 생명주기를 분리. 테스트 중 대상 Open API의 상태와 로그는 기존 사내 모니터링·로깅 시스템에서 확인.

## Stage 2. 부하 테스트 강제 종료

잘못 입력한 조건으로 테스트를 시작해도 중간에 중단할 수 없던 문제를 해결. 요청을 받은 서버와 실제 실행 서버가 달라도 Gatling 프로세스를 찾아 종료.

### 실행 중인 프로세스를 찾기 어려운 구조

초기에는 Gatling 프로세스가 종료될 때까지 기다려야 했음. Backend API 서버 4대로 요청이 분산되어 종료 요청이 실제 실행 서버에 도착한다는 보장도 없었음.

테스트 시작 시 Redis에 실행 서버 IP와 Gatling PID·Process Start Time을 저장. 종료 요청을 받은 서버는 Redis에서 실행 서버를 찾아 `WebClient`로 해당 서버의 내부 Kill API를 직접 호출. 서버 간 Kill API에는 관리자 인증 검증 적용.

```text
종료 요청 → Backend 서버 → Redis에서 실행 서버·프로세스 정보 조회
                              ↓
                       WebClient로 실행 서버의 Kill API 호출
                              ↓
                       Gatling 프로세스 검증·종료
```

### PID 재사용을 고려한 종료

PID는 다른 프로세스에 재사용될 수 있어 저장된 PID만으로 종료 대상을 판단하지 않음. 실행 서버에서 `ProcessHandle`로 현재 프로세스를 조회하고 PID와 시작 시각이 Redis에 저장된 값과 모두 일치할 때만 Gatling 프로세스로 판단.

일치하는 프로세스에 `destroy()`로 정상 종료를 먼저 시도하고, 종료되지 않으면 `destroyForcibly()` 수행. 종료 후 부하 테스트 이력을 저장하고 관리 중인 프로세스 객체 및 Redis 실행 정보 정리.

## Stage 3. 멀티 부하 테스트 방지

4대의 Backend 서버가 서로의 실행 상태를 알 수 없는 문제를 해결. Redis에서 하나의 실행권을 공유해 동시 테스트로 인한 예상 밖의 트래픽 방지.

### 서버별 로컬 상태의 한계

Load Balancer가 요청을 분산하므로 Backend A에서 테스트 중이어도 Backend B의 메모리만으로는 이를 알 수 없음. 각 서버가 별도로 실행을 허용하면 여러 Gatling 프로세스가 동시에 대상 Open API에 부하를 발생시킬 수 있었음.

### Redis `SETNX` 기반 실행 제어

여러 서버가 공유하는 Redis에서 `SETNX`로 실행권 획득. Key가 없을 때만 값을 저장하는 원자적 연산이므로 동시 요청 중 하나만 실행권을 얻고, 나머지 요청은 이미 테스트가 진행 중인 것으로 처리해 거부.

```text
테스트 실행 요청 → Redis SETNX
                       ├─ 성공 → 실행권 획득 → Gatling 실행
                       └─ 실패 → 실행 중인 테스트 존재 → 요청 거부
```

실행 중에만 필요한 일시적 상태라 영속 저장용 DB보다 공용 상태 공유와 TTL 관리가 가능한 Redis 선택. JVM 내부 Local Lock으로는 다른 Backend 서버의 실행을 제어할 수 없음.

### TTL과 종료 시 상태 정리

마지막 사용자 투입 후에도 요청이 수행될 수 있어 사용자 투입 시간만으로 TTL을 정하지 않음. 설정한 테스트 수행 시간과 사용자별 요청 실행을 고려해 여유 시간을 더하고, 비정상 종료로 정리되지 않은 Key도 영구히 남지 않도록 구성.

정상 종료 시 `finally`에서 Gatling 프로세스와 Redis 실행 정보를 정리하고, 강제 종료 시에도 실행 정보를 삭제.

## 결과

- 개발자와 운영 담당자가 웹에서 HTTP 요청 조건과 즉시·점진적·일정·Peak 부하를 설정해 Open API 테스트 수행
- 기존 모니터링·로깅 시스템을 활용해 Open API 상태 확인; 처리 한계 측정 및 Rate Limit 정책 수립에 사용할 테스트 환경 제공
- Redis의 실행 서버·프로세스 정보를 이용해 다중 서버 환경에서도 실행 중인 Gatling 프로세스 탐색 및 종료
- PID와 Process Start Time 검증, 단계적 종료, 내부 인증을 적용해 잘못된 프로세스 종료 위험 감소
- Redis `SETNX`와 TTL로 4대의 Backend 서버에서 중복 테스트 실행을 제어하고 종료 후 실행 상태 정리
