---
title: "Open API 성능 측정을 위한 부하 테스트 환경 구축 및 안정성 개선"
company: "N Tech Service"
period: "2025.06 ~ 2025.07, 2025.09"
category: "Performance Testing"
summary: "Open API 처리 한계 측정을 위한 웹 기반 부하 테스트 환경을 구축하고, 4대의 Backend API 서버에서 중복 실행과 실행 중인 프로세스의 종료를 제어"
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

## 요구사항과 기술 선정

- Open API 처리 한계 측정 및 Rate Limit 정책 수립을 위한 부하 테스트 환경 필요
- 개발자 외 직군도 웹에서 테스트 조건을 설정·실행할 수 있도록 기존 Java/Spring Boot 시스템과의 연동을 요구사항으로 설정
- JMeter, k6 등 여러 도구를 비교하고 Java DSL 기반 시나리오 구성, 동적 파라미터 전달 및 다양한 Injection Profile 지원을 고려해 Gatling 선정

## 웹 기반 부하 테스트 환경 구축

- Gatling Java DSL을 별도 프로젝트로 개발·JAR 패키징하고, Spring Boot API에서 `ProcessBuilder`로 실행해 요청 처리와 테스트 실행의 생명주기 분리
- React 화면에서 Injection 방식·시간·사용자 수와 API URL·Method·Header·Body·Parameter를 설정하고, System Property로 Gatling에 전달
- `atOnceUsers`(즉시 투입), `rampUsers`(점진적 증가), `constantUsersPerSec`(일정한 초당 사용자 투입), `stressPeakUsers`(순간 Peak) 지원
- 별도 Thread에서 Gatling 프로세스를 실행하고 시작 후 HTTP 응답을 반환해 장시간 테스트가 요청 처리를 점유하지 않도록 구성
- 대상 Open API의 상태와 성능은 기존 사내 모니터링 시스템에서 관찰

## 운영 과정에서 발견한 문제

- 테스트 시간을 잘못 설정하거나 대상 서버에 문제가 생겨도 실행 중인 Gatling 프로세스를 중단할 수 없어 과도한 트래픽 발생 위험 확인
- Backend API 서버 4대에서 서로의 로컬 실행 상태를 확인할 수 없어 여러 테스트가 동시에 실행될 수 있는 문제 확인
- 강제 종료 요청이 실행 서버와 다른 서버에 도착할 수 있고, Load Balancer에서 특정 Backend 서버로 라우팅할 수 없는 제약 확인

## 다중 서버 환경의 실행 제어 및 강제 종료

- Redis `SETNX`로 원자적으로 실행권을 획득하고, 이미 실행 중이면 요청을 거부해 4대의 Backend 인스턴스 간 중복 실행 방지
- Redis에 실행 서버 IP, Gatling PID·시작 시각(ms), `RUNNING`·`STOPPED` 상태를 저장해 실제 실행 프로세스 식별
- 강제 종료 요청을 받은 서버가 Redis에서 실행 서버를 찾고, `WebClient`로 해당 서버의 Kill API를 직접 호출하도록 구성
- 실행 서버에서 PID 재사용 가능성을 고려해 PID와 Process Start Time을 함께 검증한 뒤 `ProcessHandle.destroy()`로 종료 시도; 종료되지 않으면 `destroyForcibly()` 수행
- 정상 종료 시 `finally`에서 프로세스와 Redis 실행 정보를 정리하고, 강제 종료 시에도 Redis 정보를 삭제; 실행 정보 TTL은 사용자가 설정한 테스트 수행 시간에 맞춰 적용

## 결과

- 개발자 외 직군도 웹에서 HTTP 요청 조건과 즉시·점진적·일정·Peak 부하를 설정해 Open API 처리 성능을 검증할 수 있는 환경 구축
- 다중 서버의 중복 실행 방지와 실행 중인 테스트 종료 기능으로 잘못된 조건·반복 요청에 따른 운영 위험 감소
- Open API 처리 한계 측정 및 Rate Limit 정책 수립에 활용할 수 있는 테스트 환경 제공
