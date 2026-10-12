---
title: "Open API 부하 테스트 환경 구축 및 안정성 개선"
company: "N Tech Service"
period: "2025.06 ~ 2025.07, 2025.09"
category: "Performance Testing"
summary: "웹 기반 Open API 부하 테스트 환경을 구축하고, 4대의 Backend API 서버에서 실행 중인 테스트의 강제 종료와 중복 실행을 제어"
skills:
  - Java
  - Spring Boot
  - Gatling
  - Redis
  - React
featured: true
order: 3
draft: false
---

## 요구사항과 기술 선정

- Open API의 처리 가능한 부하를 측정하고 Rate Limit 정책 결정에 활용할 테스트 환경 필요
- 개발자 외 직군도 웹에서 조건을 설정하고 실행할 수 있도록 기존 Java/Spring Boot 시스템과 연동하는 방향 결정
- 여러 부하 테스트 도구를 비교한 뒤 Java DSL의 시스템 통합성과 다양한 트래픽 모델 지원을 고려해 Gatling 선정

## 부하 테스트 환경 구축

- Gatling Java DSL 기반 테스트 로직 개발 및 JAR 패키징
- Spring Boot API에서 `ProcessBuilder`로 Gatling JAR 실행, System Property로 테스트 조건 동적 전달
- 별도 Thread에서 Gatling 프로세스를 실행하고 테스트 시작 응답을 즉시 반환해 HTTP 요청의 장시간 대기 방지
- React 화면에서 사용자 수·투입 시간·RPS·지속 시간과 API 요청 조건을 설정하고, 여러 Injection Profile로 부하 패턴 구성
- 기존 사내 모니터링 시스템에서 대상 Open API 서버의 상태와 성능을 관찰하고 측정 결과를 Rate Limit 정책 결정에 활용

## 다중 서버 환경의 운영 문제 해결

- 운영 중 테스트 강제 종료가 불가능하고, Backend API 서버 4대의 로컬 상태만으로 중복 실행을 판단할 수 없는 문제 확인
- 강제 종료 요청이 실행 서버와 다른 서버에 도착할 수 있어 Redis에 실행 서버 IP·Hostname·Port와 Gatling PID 저장
- 요청을 받은 서버가 Redis에서 실행 서버를 조회해 해당 서버의 Process Kill API를 직접 호출하고, 실행 서버에서 `ProcessHandle`로 Gatling 프로세스 종료
- Redis `SET NX` 기반 원자적 실행 제어로 4대 서버 간 실행권을 공유하고 중복 부하 테스트 요청 거부
- 실행 상태 데이터에 10분 TTL을 적용하고 정상 종료 시 `finally`, 강제 종료 시 관련 Redis 데이터를 정리

## 결과

- 개발자 외 직군도 웹에서 다양한 트래픽 조건으로 Open API 부하 테스트를 실행할 수 있는 환경 구축
- 실행 중인 테스트의 강제 종료와 중복 실행 방지로 잘못된 조건·반복 요청에 따른 과도한 트래픽 발생 위험 감소
