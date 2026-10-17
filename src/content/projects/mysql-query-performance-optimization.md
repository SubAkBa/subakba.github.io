---
title: "대용량 데이터 환경에서의 MySQL Query Performance Optimization"
company: "N Tech Service"
category: "Database Performance"
summary: "200만~3,000만 건 규모의 데이터 환경에서 Index, JOIN, 집계 및 정렬 구조를 분석하고 개선하여 주요 Query의 실행 시간을 단축"
skills:
  - MySQL
  - SQL
  - Query Optimization
  - Index
featured: true
order: 1
draft: false
---

200만~3,000만 건 규모의 데이터 환경에서 실행계획과 데이터 처리 구조를 분석하고, Index·JOIN·집계·정렬 방식을 개선한 네 가지 독립적인 Query Tuning 사례.

## Performance Summary

| Case | Data Scale | Before | After |
| --- | --- | --- | --- |
| 복합 Index 활용 개선 | 약 3,000만 건 | 최대 약 50초 | 약 2초 |
| 대용량 JOIN / GROUP BY 제거 | 약 1,500만 + 2,000만 건 | 10초 Timeout | 평균 약 1초 |
| JOIN Column Type 불일치 대응 | 약 200만 + 900만 건 | 약 5초 | 1초 미만 |
| Anti Join / 정렬 최적화 | 약 450만 + 24만 건 | 특정 조건에서 10초 이상 Timeout | 약 1초 |

각 사례의 실행 시간은 해당 Query에서 확인한 값. SQL과 Table·Column 이름은 공개를 위해 일반화.

## Overview

### 문제 발견

- 모니터링에서 Batch 수행시간 증가 확인
- 웹 데이터 조회와 대용량 이벤트 검색 중 Timeout 발생
- 사용자로부터 권한 조회 성능 저하 제보

### 주요 분석 대상

- MySQL 실행계획과 Index Access 방식
- 복합 Index의 Column 구성 및 검색·정렬 조건
- Driving / Driven Table, JOIN 조건과 Column Data Type
- `GROUP BY` 집계, `ORDER BY` 정렬, 대용량 Table Access 비용

### 개선 방향

- 신규 Index 추가 전 기존 Index 활용도 검토
- 조회 시점의 반복적인 JOIN / 집계 제거
- 운영 Schema 변경 영향도를 고려한 Query 구조 변경
- Anti Join의 의미와 기존 Index의 정렬 특성 반영

## Case 1. 복합 Index 활용 개선

### Data Scale

- IP 정보 약 **3,000만 건**
- Batch에서 사용하는 IP 정보 수정 Query

### Problem

- 모니터링에서 Batch 수행시간 증가 확인, Query 실행 시간 최대 **약 50초**
- 기존 복합 Index: `INDEX (a, b, c)`
- 검색 조건에서 중간 Column `b` 누락
- 당시 실행계획에서 **Index Skip Scan** 사용으로 불필요한 Index 탐색 발생

```sql
WHERE a = ?
  AND c = ?
```

### Analysis

- 기존 Index `(a, b, c)`의 Column 순서와 Query 조건 비교
- `b`의 Cardinality가 2로, 두 값을 `IN (?, ?)` 조건에 포함해도 결과의 의미가 달라지지 않음 확인
- 신규 Index보다 기존 Index의 연속된 선두 Column 활용 우선 검토

### Solution

- 검색 조건에 `b IN (?, ?)` 추가해 복합 Index의 연속된 선두 Column 활용
- 실행계획의 Index Access 방식 **Index Skip Scan → Index Range Scan**으로 변경

```sql
-- Before
WHERE a = ?
  AND c = ?;

-- After
WHERE a = ?
  AND b IN (?, ?)
  AND c = ?;
```

### Result

- 신규 Index 없이 기존 복합 Index 활용 개선
- 실행 시간 **최대 약 50초 → 약 2초**

## Case 2. 대용량 JOIN / GROUP BY 제거

### Data Scale

- 알림 히스토리 약 **1,500만 건**
- 알림 재시도 히스토리 약 **2,000만 건**

### Problem

- 히스토리 조회 시 **10초로 설정된 웹 요청 Timeout** 발생
- 최종 전송 성공 여부 판단을 위해 두 대용량 Table JOIN 후 `GROUP BY` 수행
- 재시도 데이터 중 한 건이라도 성공하면 최종 결과를 성공으로 판단
- 필수 문자열 검색조건에 적절한 Index 부재

### Analysis

- 조회에 필요한 값은 재시도 히스토리의 성공 여부였으나, 이 한 값을 위해 대용량 재시도 히스토리를 JOIN하고 `GROUP BY` 집계 반복
- 단일 상태 값을 얻기 위한 대용량 JOIN / 집계 비용이 비효율적이라고 판단
- SQL 미세 조정보다 상태를 알림 히스토리에 저장해 Read 시점의 JOIN / 집계 자체를 제거하는 방향 선택

### Solution

- 알림 히스토리에 `status` Column 추가, `SUCCESS`·`FAIL`·`RETRY` 상태 저장
- 조회 Query에서 재시도 히스토리 JOIN 및 `GROUP BY` 제거
- 필수·빈번한 검색조건과 Cardinality를 고려해 Index 재구성으로 Table Access 감소

```text
Before: READ → History + Retry History → JOIN → GROUP BY → 성공 여부 계산
After:  WRITE → History의 status에 상태 저장
        READ  → status 직접 조회
```

### Result

- 반복 계산을 Write 시점으로 이동하고 Read 시점의 대용량 JOIN / 집계 제거
- 실행 시간 **10초 Timeout → 평균 약 1초**

## Case 3. JOIN Column Data Type 불일치 대응

### Data Scale

- SQL Client 권한 데이터 약 **200만 건**
- SQL Client 권한 세부 데이터(SELECT, INSERT, UPDATE, DELETE, DDL, EXECUTE) 약 **900만 건**

### Problem

- 사용자로부터 권한 조회 성능 저하 제보, 기존 Query 실행 시간 **약 5초**
- JOIN Key의 Data Type 불일치: `VARCHAR ↔ BIGINT`
- JOIN 과정에서 Index를 원하는 방식으로 활용하기 어려운 구조

### Analysis

- 근본적인 대안: JOIN Key의 Data Type 통일
- 대상 Column이 PK와 관련되어 기존 기능·연관 시스템에 영향 가능
- 대용량 데이터 변경에 따른 DB 부하와 운영환경 변경 위험 검토

### Solution

- 즉각적인 Schema 변경 대신 기존 구조 유지
- WHERE 조건을 적용하는 Table을 바꿔 **Driving Table 변경**
- 기존 Index를 더 효과적으로 활용하도록 Query 구조 개선

### Result

- 운영 중인 PK Schema 변경과 연관 시스템 영향 회피
- 실행 시간 **약 5초 → 1초 미만**

## Case 4. Anti Join 및 정렬 최적화

### Data Scale

- Event 약 **450만 건** — Driving Table
- Server 약 **24만 건** — Driven Table

### Problem

- 검색 결과가 없거나 10건 이하인 특정 조건에서 Query 실행 시간 **10초 이상**, 웹 요청 Timeout 발생
- Event와 Server를 Outer Join한 뒤 Driven Table에 `IS NULL` 적용
- 당시 실행계획에서 Hash Join 수행

```sql
SELECT ...
FROM event e
LEFT JOIN server s ON ...
WHERE s.id IS NULL
ORDER BY e.created_at DESC;
```

### Analysis

- 실제 요구사항: Server에 대응 데이터가 없는 Event를 최신순으로 조회
- `LEFT JOIN ... IS NULL`의 Anti Join 의미 확인
- Event와 Server JOIN 시 Event당 약 10건의 Server 데이터가 매칭되어, 존재 여부만 필요한 조회에 불필요한 행 결합 발생
- `ORDER BY created_at`에 활용할 Index가 없어 결과가 없거나 10건 이하로 페이징해도 전체 후보의 정렬 작업이 발생하고 조기 종료가 어려움
- `event_id`가 생성 순서를 보장하고, 이를 선두 Column으로 하는 Index가 이미 있음 확인
- 이 Query에서는 `event_id DESC`로 필요한 최신순 표현 가능

### Solution

- Outer Join + `IS NULL`을 `NOT EXISTS`로 변경해 Server 데이터의 존재 여부만 확인하고 중복 행 결합 연산 감소
- 정렬 기준을 `created_at DESC`에서 Index가 있는 `event_id DESC`로 변경
- 기존 `event_id` 선두 Index를 활용해 별도 정렬 작업 제거

```sql
SELECT ...
FROM event e
WHERE NOT EXISTS (
    SELECT 1
    FROM server s
    WHERE ...
)
ORDER BY e.event_id DESC;
```

### Result

- 신규 Index 없이 Anti Join 구조와 Index 기반 정렬 활용
- 실행 시간 **특정 조건에서 10초 이상 Timeout → 약 1초**

> `NOT EXISTS`가 `LEFT JOIN`보다 항상 빠르다는 의미는 아님. 당시 데이터 구조, 실행계획 및 Index 구성을 기준으로 선택.

## Technical Decisions

- **기존 Index 우선:** 복합 Index의 Column 순서와 검색조건을 비교하고 업무조건 변경 가능성 확인
- **Read 비용 제거:** 반복되는 JOIN / `GROUP BY`를 저장 시점의 결과 계산으로 대체
- **운영 영향도 고려:** PK Schema 변경이 연관 시스템과 대용량 데이터에 미칠 영향 평가
- **검색·정렬 함께 분석:** 동일한 최신순을 보장하는 Column과 기존 Index의 정렬 특성 활용

## Lessons Learned

- 실행계획의 Index Access 방식, Driving / Driven Table, JOIN 조건을 함께 분석
- SQL 문법뿐 아니라 데이터 모델과 Read / Write 계산 시점을 포함해 최적화 범위 판단
- 성능 수치와 함께 운영 시스템의 변경 비용 및 적용 위험 고려
