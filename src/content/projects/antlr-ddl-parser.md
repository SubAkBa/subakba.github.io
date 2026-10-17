---
title: "ANTLR 기반 DDL Parser 재설계 및 레거시 Parser 교체"
company: "N Tech Service"
period: "2026.06 ~ 2026.07"
category: "Parser Architecture"
summary: "1만 줄 이상의 단일 파일과 높은 유지보수 비용을 가진 기존 DDL Parser를 ANTLR 기반으로 재설계하고, DBMS별 Parser 구조 분리와 검증 환경 구축을 통해 평균 유지보수 작업 시간을 약 1일에서 약 2시간으로 단축"
skills:
  - Java
  - ANTLR4
  - Spring Boot
featured: true
order: 4
draft: false
---

## 문제와 원인

- 기존 DDL Parser는 JJT 문법 기반으로 구현되어 문법과 코드 구조를 파악하는 데 높은 학습 비용 발생
- 하나의 파일에 1만 줄 이상의 코드가 집중되고 기능·DBMS별 책임이 혼재되어 버그 수정과 요구사항 변경의 영향 범위 파악이 어려움
- 실제 시스템에서 사용하지 않는 DML·TCL Query Type까지 포함되어 DDL 처리에 불필요한 복잡도 존재
- MySQL, MSSQL, PostgreSQL, Oracle 및 사내 전용 DBMS를 지원해야 했으나, 외부 오픈소스 Parser에서는 자체 DBMS 문법 확장이 어려움
- 변경이 다른 DBMS와 DDL 처리 로직에 영향을 줄 가능성이 높아 유지보수 비용 증가

## Parser 기술 선정

기존 Parser의 구조적 문제 해결을 위해 범용 SQL Parser 교체와 Parser Generator 기반 DDL 문법 직접 구현 방식 비교

| 후보 | 장점 | 이번 시스템에서의 판단 |
| --- | --- | --- |
| [JSqlParser](https://jsqlparser.github.io/JSqlParser/) | Java 객체 구조로 파싱 결과 제공, 여러 DBMS 문법 지원 | 사내 전용 DBMS 문법을 추가하려면 범용 Grammar와 관련 구조를 함께 관리해야 해 기존 유지보수 문제를 충분히 줄이기 어려움 |
| [Apache Calcite](https://calcite.apache.org/) | SQL Parser 외에 Validation과 쿼리 최적화 기능 제공 | Parser를 별도로 사용할 수 있지만 DDL 문법만 직접 통제하려는 목표에 비해 기능 범위가 넓음 |
| [jOOQ Parser](https://www.jooq.org/doc/latest/manual/sql-building/sql-parser/sql-parser-api/) | 여러 SQL Dialect 파싱 및 SQL 변환 기능 제공 | 자체 DDL Grammar를 중심으로 Parser를 설계하려는 요구와 방향이 다름 |
| [JavaCC / JJTree](https://javacc.github.io/javacc/documentation/jjtree.html) | Grammar를 정의해 Java Parser와 Parse Tree 생성 가능 | 기존 Parser에서 경험한 JJT 문법과 Tree 처리 구조의 유지보수 비용을 근본적으로 줄이기 어려움 |
| [ANTLR](https://github.com/antlr/antlr4) | Grammar 직접 정의, Lexer/Parser 생성, Parse Tree의 Listener/Visitor 제공 | Grammar를 직접 관리해야 하지만 필요한 DDL과 DBMS별 문법만 통제할 수 있음 |

### ANTLR을 선택한 이유

- 범용 SQL 전체가 아닌 DDL 처리에 집중하고 DML·TCL 등 미사용 문법은 제외할 수 있음
- MySQL·Oracle·PostgreSQL·MSSQL뿐 아니라 사내 전용 DBMS의 문법을 직접 정의·확장할 수 있음
- `.g4` Grammar로 Lexer/Parser를 생성하고, Listener/Visitor를 통해 Parse Tree 이후 처리 로직을 Java 코드로 분리할 수 있음
- DBMS별 Parser 책임을 분리해 특정 문법 변경이 다른 DBMS에 미치는 영향을 제한할 수 있음

**기술 선정 기준: SQL 문법 지원 범위보다 실제 사용하는 DDL 문법의 직접 통제·확장·유지보수 가능성**

## DDL Parser 구조 재설계

- ANTLR 기반 DDL Parser를 신규 개발하고 `.g4` Grammar로 Lexer와 Parser 생성
- DML·TCL 등 미사용 Query Type을 제거하고 시스템에서 필요한 DDL 처리에 집중
- 파싱 이후 처리 로직을 Java로 구성하고, DBMS별 Parser 로직과 공통 처리 영역 분리
- DBMS별 차이만 개별 구현하도록 구조화해 신규 DBMS 및 DDL 문법 확장에 대응
- 반복적인 DBMS별 Parser 개발 작업을 표준화하기 위해 Codex Skill 작성

## 기존·신규 Parser 비교 검증 환경 구축

- Parser 교체 전 기존 기능과의 호환성을 확인하기 위한 별도 웹 프로젝트 개발
- 동일한 DDL Script를 기존 jsql-parser 기반 Parser와 신규 ANTLR Parser에 입력해 파싱 결과 비교
- 결과 차이를 검토하며 기존 Parser에서 처리하지 못했던 DDL Query와 Parser Bug 식별
- 신규 Parser 적용 전 동작 차이를 확인할 수 있게 하여 교체에 따른 회귀 위험 최소화

## 결과

- **평균 유지보수 작업 시간: 약 1일 → 약 2시간**
- **신규 Parser 구조 적용 이후 코드 수정에 따른 사이드 이펙트: 0건**
- 기존 Parser에서 정상 처리하지 못했던 DDL Query 및 Parser Bug 개선
- DBMS별 Parser 책임 분리와 공통 로직 추상화로 변경 영향 범위 축소
- 불필요한 Query Type 제거와 역할 분리로 코드 가독성 및 유지보수성 개선
