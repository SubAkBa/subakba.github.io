---
title: "ANTLR 기반 DDL Parser 재설계 및 레거시 Parser 교체"
company: "N Tech Service"
period: "2026.06 ~ 2026.07"
role: "기술 검토부터 설계·구현·검증·운영 전환까지 단독 담당"
category: "Parser Architecture"
summary: "JSqlParser 기반 DDL Parser의 지원 범위와 구조를 재설계하고, DBMS별 Grammar 분리와 결과 비교 검증을 거쳐 ANTLR Parser로 전환. 유지보수 작업은 통상 약 1일에서 약 2시간 수준으로 단축"
skills:
  - Java
  - ANTLR4
  - Spring Boot
featured: true
order: 4
draft: false
---

기존 Parser의 변경 지점을 분석하고 시스템에 필요한 DDL 범위를 다시 정의했다. 이후 DBMS별 Grammar와 공통 Parsing 흐름을 분리하고, Legacy Parser와 결과를 비교하면서 운영 전환까지 진행했다.

## 기존 구조와 문제

기존 시스템은 범용 SQL Parser인 JSqlParser의 소스를 시스템 요구에 맞게 일부 수정해 사용했다. [JSqlParserCC.jjt](https://github.com/JSQLParser/JSqlParser/blob/master/src/main/jjtree/net/sf/jsqlparser/parser/JSqlParserCC.jjt)를 기반으로 한 1만 줄 이상의 JJT 파일에 여러 SQL 유형과 DBMS 문법이 함께 있었다.

- JJT/JavaCC 문법에 익숙하지 않으면 Parser의 동작과 변경 지점을 파악하기 어려웠다.
- 시스템에서 사용하지 않는 DML·TCL 문법도 DDL과 함께 관리해야 했다.
- DBMS별 문법이 한 파일에 섞여 있어 사내 DBMS나 신규 DDL 문법을 추가할 때 영향 범위가 넓었다.
- Parser Bug로 사용자 문의가 반복되었고, 변경 때마다 기존 DDL의 동작도 확인해야 했다.

JSqlParser 자체의 한계라기보다 **범용 Parser를 직접 수정해 유지하는 방식이 Table·Column·Index 중심의 제한적인 DDL 요구사항과 맞지 않았다.** 문법과 DBMS가 늘수록 수정 범위와 검증 부담이 함께 커지는 구조였다.

<figure class="parser-visual parser-architecture" aria-label="기존 Parser와 개선한 Parser 구조 비교">
  <figcaption><span>ARCHITECTURE</span><strong>하나의 범용 문법 파일에서 DBMS별 책임 분리로</strong></figcaption>
  <div class="parser-architecture-columns">
    <section class="parser-architecture-lane is-legacy" aria-label="기존 구조">
      <p class="parser-visual-label">BEFORE · JSqlParser 기반</p>
      <div class="parser-visual-node"><strong>JSqlParserCC.jjt</strong><small>1만 줄 이상의 단일 문법 파일</small></div>
      <span class="parser-visual-arrow" aria-hidden="true">↓</span>
      <div class="parser-visual-node"><strong>SQL 유형과 DBMS 문법 혼재</strong><span class="parser-visual-chips"><em>DDL</em><em>DML</em><em>TCL</em><em>여러 DBMS</em></span></div>
      <p class="parser-visual-note">한 문법을 고칠 때 다른 문법과 DBMS의 영향도 함께 확인</p>
    </section>
    <section class="parser-architecture-lane is-new" aria-label="개선 구조">
      <p class="parser-visual-label">AFTER · ANTLR 기반</p>
      <div class="parser-visual-node"><strong>Backend API</strong><small>dbmsType에 맞는 XxxDbmsParser 선택</small></div>
      <span class="parser-visual-arrow" aria-hidden="true">↓</span>
      <div class="parser-visual-node"><strong>DBMS별 Grammar · Parser</strong><small>XxxLexer.g4 + XxxParser.g4 + XxxDbmsParser</small></div>
      <span class="parser-visual-arrow" aria-hidden="true">↓</span>
      <div class="parser-visual-node"><strong>AbstractDbmsParser</strong><small>공통 Parsing 흐름 재사용 → Parse Tree</small></div>
    </section>
  </div>
</figure>

## 기술 선정과 지원 범위

Parser 교체를 결정한 뒤 후보 기술을 문서 기반으로 비교했다. ANTLR을 선택한 기준은 전체 SQL 지원 범위보다 **현재 시스템에서 필요한 DDL을 직접 정의하고 DBMS별로 독립적으로 확장할 수 있는가**였다.

- Table·Column·Index의 생성·수정·삭제에 필요한 문법만 Grammar에 정의할 수 있다.
- DBMS별 Lexer와 Parser Grammar를 분리해 특정 DBMS의 문법 변경을 해당 구현 안에서 다룰 수 있다.
- 밀접하게 연관된 다른 사내 시스템의 ANTLR Parser 설계·운영 사례를 참고할 수 있었다. 그 시스템은 DDL뿐 아니라 DML도 처리하고 있었다.

신규 Parser는 모든 SQL을 처리하지 않는다. 지원 범위를 Table·Column·Index 관련 DDL로 제한하고, 시스템이 실제 사용하는 정보를 정확히 추출하는 데 집중했다.

| 대상 | 추출 정보 |
| --- | --- |
| Table | 이름 |
| Column | 이름, Table 내 위치, Data Type, Collate, Charset, Nullable, Primary Key, Default, Comment |
| Index | 이름, 유형, Column과 순서, 정렬 방식(`ASC`, `DESC`) |

## DBMS별 Grammar와 공통 Parser 설계

MySQL·Oracle·PostgreSQL·MSSQL 등 DBMS마다 Lexer와 Parser Grammar를 분리했다. Java 계층에서는 `DbmsParser`를 외부 API로 두고 `parse`, `validate`, `splitSQLByStatement`, `getAllEntities`를 제공한다.

`AbstractDbmsParser`는 ANTLR의 Lexer·Parser·ParserRuleContext를 이용하는 공통 Parsing 흐름을 담당한다. 각 `XxxDbmsParser`는 이를 상속해 Lexer와 Parser 생성, Root Rule 호출, DBMS별 Listener 지정만 구현한다. Backend API는 `dbmsType`에 맞는 Parser를 선택한다.

```text
DBMS별 구성
├── XxxLexer.g4
├── XxxParser.g4
├── XxxDbmsParser
├── XxxEntityCollector
└── XxxSplitListener
```

공통 Pipeline을 재사용하므로 신규 DBMS를 추가할 때 기존 Parser 전체를 수정하지 않고 해당 DBMS의 Grammar와 구현에 집중할 수 있다. 이 반복 패턴을 Grammar → DbmsParser → EntityCollector → SplitListener → Test 순서로 정리한 Codex Skill도 작성했다.

## ANTLR Parsing 흐름

실행할 때는 **DBMS 선택 → 쿼리를 단어와 기호로 구분 → SQL 구조 파악 → 문장 위치와 테이블·컬럼 정보 추출** 순서로 진행한다. 아래 탭에서 `CREATE TABLE`, `ALTER TABLE`, 여러 SQL 문장을 선택하면 각 단계에서 데이터가 어떻게 달라지는지 볼 수 있다. 실제 사내 문법과 무관한 공개용 쿼리다.

<div id="parser-flow-animation-slot"></div>

`SplitListener`는 분석된 SQL 구조에서 문장별 원문과 위치를 기록한다. `EntityCollector`는 **같은 구조**에서 Table·Column·Index의 이름과 위치를 추출한다. 여러 SQL 문장이 한 번에 들어와도 문장 단위로 나누고, 필요한 객체 정보를 찾을 수 있다.

<details class="parser-terms">
  <summary>ANTLR 구현 용어 살펴보기</summary>
  <ul>
    <li><code>CharStream</code>: SQL 원문을 ANTLR에 전달하는 입력 형식</li>
    <li><code>CommonTokenStream</code>: Lexer가 구분한 단어와 기호를 Parser에 전달하는 묶음</li>
    <li><code>ProgramContext</code>·Parse Tree: Parser가 SQL을 해석해 만든 문장 구조</li>
    <li><code>SingleStatementContext</code>: 그 구조 안에서 SQL 한 문장에 해당하는 부분</li>
    <li><code>CollectingErrorListener</code>: 문법에 맞지 않는 부분을 감지해 <code>ParseError</code>로 기록하는 클래스</li>
  </ul>
  <p><code>antlr4-maven-plugin</code>은 빌드 시 <code>.g4</code> Grammar에서 Java 코드를 생성한다. 생성 결과는 <code>target/generated-sources/antlr4/</code>에 두고 직접 수정하지 않는다. 단어·키워드는 Lexer Grammar에서, SQL 문장 구조는 Parser Grammar에서 수정한 뒤 코드를 다시 생성한다.</p>
  <p>Grammar의 Rule과 Label은 생성되는 Context와 Listener API에 직접 연결되므로, 문법 변경 시 문장 분리와 객체 추출 결과까지 확인했다.</p>
</details>

## Legacy 결과와 비교 검증

신규 Parser를 즉시 교체하지 않고 별도 웹 프로젝트에서 두 Parser의 결과를 나란히 확인했다. DBMS와 DDL Query를 입력하면 각 Parser의 결과를 JSON으로 보여 주어 차이를 비교할 수 있게 했다.

<figure class="parser-visual parser-comparison" aria-label="Legacy Parser와 ANTLR Parser의 결과 비교 검증">
  <figcaption><span>COMPATIBILITY CHECK</span><strong>같은 DDL을 두 Parser에 입력하고 결과를 비교</strong></figcaption>
  <div class="parser-comparison-input"><small>동일한 입력</small><strong>DBMS 선택 + DDL Query</strong></div>
  <div class="parser-comparison-branches" aria-hidden="true"><span>↙</span><span>↘</span></div>
  <div class="parser-comparison-lanes">
    <div class="parser-comparison-lane"><span>LEGACY</span><strong>기존 Parser</strong><small>Parsing Result → JSON</small></div>
    <div class="parser-comparison-lane is-new"><span>ANTLR</span><strong>신규 Parser</strong><small>Parsing Result → JSON</small></div>
  </div>
  <div class="parser-comparison-merge" aria-hidden="true">↘ &nbsp;&nbsp;&nbsp;&nbsp; ↙</div>
  <div class="parser-comparison-result"><strong>반환 데이터 비교</strong><small>차이가 있으면 Grammar · Parse Tree · Listener 결과 · 기존 동작 확인</small></div>
</figure>

검증 기준은 Syntax Parsing 성공 여부에 그치지 않았다. **동일한 DDL에 대해 신규 Parser가 반환한 결과가 기존 Parser의 결과와 동일하게 동작하는지** 확인했다. 차이가 있으면 Grammar, Parse Tree, Listener 처리, Legacy Parser의 기존 동작 중 어디에서 비롯됐는지 살폈다.

지원 대상과 미지원 대상 SQL을 파일로 관리했다. 대표적인 지원 대상 DDL 약 50개로 Syntax Parsing, Parse Tree 생성, Entity 추출을 자동 테스트했다.

## 기존 문제 개선과 운영 전환

호환성을 검증하면서 기존 Parser의 동작을 무조건 복제하지는 않았다. Legacy Parser가 지원하지 못하던 Function Based Index 생성 DDL을 지원 범위에 포함했다. 또 MySQL Column 정의에서 `DEFAULT CURRENT_TIMESTAMP`, `ON UPDATE CURRENT_TIMESTAMP`, `NOT NULL`의 위치 조합에 따라 Column 정보를 의도와 다르게 Parsing하던 문제를 개선했다. 이 문제는 사용자 문의로도 이어졌었다.

전환은 **ANTLR Parser 구현 → 자동 테스트 → Legacy·ANTLR 결과 비교 → 병행 운영 및 검증 → Legacy Parser 제거** 순서로 진행했다. 이를 통해 기존에 정상 동작하던 DDL의 회귀 위험을 줄였다. 운영 반영 이후 현재까지 기존에 정상적으로 처리되던 DDL이 신규 Parser에서 동작하지 않는다는 사용자 문의는 발생하지 않았다.

## 결과와 회고

- **유지보수 작업 시간 단축:** Jira에 기록된 신규 DDL 지원·기존 DDL 변경·신규 DBMS 문법 추가 작업 시간과 Legacy Parser 작업 이력을 비교했을 때, 통상 약 1일 걸리던 작업이 전환 후 약 2시간 수준으로 줄었다.
- **변경 영향 범위 축소:** DBMS별 Grammar와 Parser 구현을 분리해 특정 DBMS 문법 변경 시 다른 DBMS Parser에 미치는 영향을 줄였다.
- **기존 동작 개선:** Function Based Index 지원과 MySQL `CURRENT_TIMESTAMP` 관련 Parsing 문제를 개선했다.
- **안전한 전환:** 결과 비교 환경과 병행 검증을 거친 뒤 Legacy Parser를 제거했다.

이번 작업의 핵심은 라이브러리 교체보다 Parser가 담당할 범위를 명확히 정의하고, 변경이 발생하는 지점을 DBMS별로 분리하며, 기존 동작과의 호환성을 검증할 수 있는 구조를 만든 데 있다.
