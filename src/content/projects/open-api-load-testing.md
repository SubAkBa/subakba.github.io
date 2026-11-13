---
title: "Open API 성능 측정을 위한 부하 테스트 환경 구축 및 안정성 개선"
company: "N Tech Service"
period: "2025.06 ~ 2025.07, 2025.09"
category: "Performance Testing"
summary: "React·Spring Boot·Gatling으로 웹 부하 테스트 환경을 구축하고, Redis로 4대 서버의 실행 프로세스 종료와 중복 실행을 제어"
skills:
  - Java
  - Spring Boot
  - Gatling
  - Gatling Java DSL
  - Redis
  - React
  - WebClient
featured: true
order: 4
draft: false
---

## 작업 배경

Open API의 처리 가능한 요청량을 확인하고 Rate Limit 정책 수립에 활용하기 위해 **React·Spring Boot·Gatling 기반 웹 부하 테스트 환경을 구축**했다. 이후 4대의 Backend API 서버에서 실행 중인 테스트를 찾아 종료하고, Redis로 중복 실행을 제어했다.

기존에는 개발자가 테스트 코드를 직접 작성·실행해야 해 조건을 바꿔 반복하거나 운영 담당자가 사용하기 어려웠다.

## 개선 흐름

<ol class="project-journey" aria-label="부하 테스트 환경 개선 단계">
  <li><strong>01 · 환경 구축</strong><span>수동 실행 → 웹에서 조건 설정·실행</span></li>
  <li><strong>02 · 강제 종료</strong><span>실행 서버 탐색 → 프로세스 검증·종료</span></li>
  <li><strong>03 · 중복 실행 방지</strong><span>서버별 로컬 상태 → Redis 실행권 공유</span></li>
</ol>

아래 탭에서 각 단계의 문제와 해결 과정을 확인할 수 있다.

## Stage 1. 부하 테스트 환경 구축

웹에서 요청 조건과 부하 패턴을 설정하고, 별도 Gatling 프로세스로 Open API에 테스트 트래픽을 생성했다.

### 부하 테스트 도구 선정

정해진 시나리오를 반복 실행하는 대신 웹에서 입력한 요청 조건과 부하 패턴을 실행 시점에 적용해야 했다. JMeter, k6, The Grinder, Gatling을 기존 Java/Spring Boot 환경과 동적 테스트 구성 요건으로 비교했다.

| 도구 | 특징 | 검토 결과 |
| --- | --- | --- |
| JMeter | GUI 기반 시나리오 구성 | 테스트 작성은 편리하지만 웹 입력값으로 시나리오를 코드에서 동적으로 구성하는 구조에는 적합도가 낮다고 판단 |
| k6 | JavaScript 기반 Test as Code | 테스트 코드가 간결하지만 기존 Java 프로젝트와 별도의 언어·실행 환경 관리 필요 |
| The Grinder | Java 기반 분산 부하 테스트 프레임워크 | 공식 배포·프로젝트 업데이트가 장기간 정체돼 버그 발생 시 해결·유지보수에 어려움이 있을 것으로 판단 |
| Gatling | Java DSL 기반 Test as Code | 기존 Java 빌드 환경을 활용하면서 요청과 Injection Profile을 코드로 구성하고 외부 파라미터를 적용하기 용이 |

Gatling Java DSL에서는 Backend API가 전달한 값을 System Property로 읽어 테스트 조건에 적용할 수 있다. 다음은 전달 방식만 나타낸 공개용 예시다.

```java
String targetUrl = System.getProperty("url");
String httpMethod = System.getProperty("httpMethod");
int users = Integer.parseInt(System.getProperty("users"));
```

**기존 Java 환경과의 통합, 입력값을 이용한 테스트 구성, 다양한 Injection Profile 지원**을 기준으로 Gatling을 선정했다.

### 반복 테스트를 위한 웹 환경

React 화면에서 URL·HTTP Method·Header·Parameter·Body와 사용자 수·투입 시간·부하 지속 시간·Injection 방식을 설정할 수 있도록 구현했다.

Gatling Java DSL 시나리오를 별도 프로젝트의 JAR로 패키징했다. Spring Boot API는 화면의 입력값을 System Property로 전달하고 `ProcessBuilder`로 JAR를 실행한다. 테스트 조건을 바꿀 때마다 Gatling 코드를 수정할 필요가 없는 구조다.

```text
React 화면 → Spring Boot API → ProcessBuilder + System Property
                                      ↓
                                  Gatling JAR → Open API
```

### 다양한 트래픽 패턴

| Injection 방식 | 테스트 패턴 |
| --- | --- |
| `atOnceUsers` | 사용자 즉시 투입 |
| `rampUsers` | 지정한 사용자를 일정 시간에 걸쳐 균등 투입 |
| `constantUsersPerSec` | 일정한 초당 사용자 투입 |
| `stressPeakUsers` | 순간적인 Peak 트래픽 |

### 요청 처리와 테스트 실행 분리

Spring Boot API는 별도 Thread에서 Gatling 프로세스를 실행하고 테스트 시작 후 HTTP 응답을 반환한다. 테스트가 끝날 때까지 요청 Thread를 대기시키지 않기 위한 선택이다.

Backend API의 요청 처리와 Gatling 프로세스의 실행 생명주기를 분리했다. 테스트 중 대상 Open API의 상태와 로그는 새 모니터링 시스템을 만들지 않고 기존 사내 모니터링·로깅 시스템에서 확인했다.

## Stage 2. 부하 테스트 강제 종료

잘못 입력한 조건으로 시작한 테스트를 중단할 수 없었다. 종료 요청을 받은 서버와 실제 실행 서버가 달라도 Gatling 프로세스를 찾아 종료하도록 개선했다.

### 실행 중인 프로세스를 찾기 어려운 구조

초기에는 Gatling 프로세스가 종료될 때까지 기다려야 했다. 부하 테스트는 Backend API 서버 4대 중 한 대에서 실행되지만, 강제 종료 요청이 같은 서버에 도착한다는 보장은 없었다.

```text
사내 Load Balancer
  ├─ Nginx #1 → Backend API #1
  ├─ Nginx #2 → Backend API #2
  ├─ Nginx #3 → Backend API #3
  └─ Nginx #4 → Backend API #4
```

### 강제 종료 방식 검토

| 후보 | 검토 결과 |
| --- | --- |
| 특정 서버로 라우팅 | 클라이언트가 실행 서버를 알 수 없고 Load Balancer는 특정 서버 지정 미지원; Nginx는 서버마다 개별 구성돼 공통 라우팅에 활용 불가 |
| 실행 서버 API 직접 호출 | Redis에서 실행 서버를 찾아 해당 서버의 내부 API 호출 가능 |

특정 서버로 종료 요청을 라우팅하기 어려워 강제 종료 진행 API와 실제 Process Kill API를 분리했다. 종료 요청을 받은 서버가 실행 서버를 찾아 내부 API를 직접 호출하는 방식으로 결정했다.

### 실행 서버로 종료 요청 전달

테스트 시작 시 Redis에 실행 서버 IP와 Gatling PID·Process Start Time을 저장했다. 강제 종료 진행 API는 Redis에서 실행 서버 IP를 조회해 `WebClient`로 해당 서버의 내부 Process Kill API를 직접 호출한다. 이 서버 간 호출은 Load Balancer를 거치지 않으며, 내부 Kill API에는 관리자 인증 검증을 적용했다.

```text
종료 요청 → 강제 종료 진행 API (요청을 받은 Backend 서버)
                ↓ Redis에서 실행 서버 조회
             WebClient로 실행 서버의 Process Kill API 호출
                ↓
          실행 서버에서 PID·시작 시각 일치 확인
                ↓
          ProcessHandle로 Gatling 종료
```

### PID 재사용을 고려한 종료

운영체제에서 PID가 재사용될 수 있어 저장된 PID만으로 종료 대상을 판단하지 않았다. 실행 서버에서 `ProcessHandle`로 현재 프로세스를 조회하고, PID와 시작 시각이 Redis 값과 모두 일치할 때만 종료 대상으로 판단한다.

일치하는 프로세스에 `destroy()`로 종료를 먼저 시도하고, 살아 있으면 `destroyForcibly()`를 호출한다. 종료 처리 후 부하 테스트 이력을 저장하고 관리 중인 `Process` 객체와 Redis 실행 정보를 정리한다.

## Stage 3. 멀티 부하 테스트 방지

4대의 Backend 서버가 서로의 로컬 실행 상태를 알 수 없었다. Redis에서 하나의 실행권을 공유해 중복 테스트 실행을 제어했다.

### 서버별 로컬 상태의 한계

Load Balancer가 요청을 분산하므로 Backend A에서 테스트 중이어도 Backend B의 메모리만으로는 이를 알 수 없다. 각 서버가 별도로 실행을 허용하면 여러 Gatling 프로세스가 동시에 대상 Open API에 부하를 발생시킬 수 있었다.

### Redis `SETNX` 기반 실행 제어

여러 서버가 공유하는 Redis에서 `SETNX`로 실행권을 획득한다. Key가 없을 때만 저장하는 원자적 연산으로 동시 요청 중 하나만 실행권을 얻고, 나머지는 이미 테스트가 진행 중인 것으로 처리해 거부한다.

```text
테스트 실행 요청 → Redis SETNX
                       ├─ 성공 → 실행권 획득 → Gatling 실행
                       └─ 실패 → 실행 중인 테스트 존재 → 요청 거부
```

실행 상태는 테스트 중에만 필요한 일시적 데이터이므로 TTL을 설정하고 서버 간 공유할 수 있는 Redis를 선택했다. JVM 내부 Local Lock만으로는 다른 Backend 서버의 실행을 제어할 수 없다.

### TTL과 종료 시 상태 정리

마지막 사용자를 투입한 뒤에도 요청이 수행될 수 있어 투입 시간만으로 TTL을 정하지 않았다. 설정한 테스트 수행 시간과 사용자별 요청 실행을 고려한 여유 시간을 더해 TTL을 적용했다.

테스트 실행이 끝나면 `finally`에서 Gatling 프로세스와 Redis 실행 정보를 정리한다. 강제 종료 시에도 실행 정보를 삭제한다. TTL은 삭제가 누락된 상태 데이터의 장기 잔존 위험을 줄이기 위한 보조 장치다.

## 결과

- 개발자와 운영 담당자가 웹에서 HTTP 요청 조건과 부하 패턴을 바꿔 Open API 부하 테스트를 실행할 수 있는 환경 구축
- 기존 모니터링·로깅 시스템을 이용해 대상 서버 상태를 관찰하고, 처리 한계 측정 및 Rate Limit 정책 수립에 사용할 테스트 환경 제공
- Redis에서 실행 서버를 찾고 PID·시작 시각을 검증한 뒤 Gatling 프로세스를 단계적으로 종료하도록 구성
- Redis `SETNX`로 중복 실행 요청을 거부하고, 테스트 종료 시 상태 삭제 및 TTL로 실행 정보 관리
