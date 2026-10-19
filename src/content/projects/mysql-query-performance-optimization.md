---
title: "대용량 데이터 환경에서의 MySQL Query Performance Optimization"
company: "N Tech Service"
category: "Database Performance"
summary: "대용량 데이터 환경에서 Index·집계 구조와 이벤트 조회의 제외·포함 조건을 개선해 주요 Query의 실행 시간을 단축"
skills:
  - MySQL
  - SQL
  - Query Optimization
  - Index
featured: true
order: 1
draft: false
---

대용량 데이터 환경에서 실행계획과 조회 구조를 분석하고, 기존 Index 활용·집계 제거·존재 여부 기반 필터링으로 개선한 튜닝 사례.

## Performance Summary

| Case | Data Scale | Before | After |
| --- | --- | --- | --- |
| 복합 Index 활용 개선 | 약 3,000만 건 | 최대 약 50초 | 약 2초 |
| 알림 조회 JOIN·집계·정렬 최적화 | 약 1,500만 + 2,000만 건 | 10초 Timeout | 평균 약 1초 |
| 이벤트 제외·포함 조건 개선 | Event 약 450만 + Server 약 24만 건 | 10초 이상 Timeout | 약 1초 |

각 실행 시간은 해당 Query에서 확인한 값. SQL과 Table·Column 이름 및 일부 조건은 공개를 위해 일반화.

## Overview

### 문제 발견

- 모니터링에서 Batch 수행시간 증가 확인
- 웹 히스토리 조회 및 이벤트 검색 중 Timeout 발생

### 주요 분석 대상

- MySQL 실행계획과 Index Access 방식
- 복합 Index의 Column 구성 및 검색 조건
- `GROUP BY` 집계와 `ORDER BY` 정렬, 대용량 Table Access 비용
- 이벤트 조회의 제외 서비스 필터와 모니터링 그룹 서버 포함 조건

### 개선 방향

- 신규 Index 추가 전 기존 Index 활용도 검토
- 조회 시점의 반복적인 JOIN / 집계 제거
- 필수 검색조건에 사용한 Column과 정렬 Column을 맞춰 Index 순서 활용
- 제외 서비스와 모니터링 그룹 서버의 존재 여부를 `NOT EXISTS`·`EXISTS`로 판별

## Tuning Cases

탭을 선택하면 각 Query의 문제, 분석 과정, 변경 내용과 결과를 볼 수 있다.

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

## Case 2. 알림 조회의 JOIN·집계·정렬 최적화

### Data Scale

- 알림 히스토리 약 **1,500만 건**
- 알림 재시도 히스토리 약 **2,000만 건**

### Problem

- 히스토리 조회 시 **10초로 설정된 웹 요청 Timeout** 발생
- 최종 전송 성공 여부 판단을 위해 `notification_history`와 `notification_retry_history`를 JOIN한 뒤 `GROUP BY` 수행
- 재시도 데이터 중 한 건이라도 성공하면 최종 결과를 성공으로 판단
- 필수 문자열 검색조건에 적절한 Index 부재
- JOIN·집계를 제거한 뒤에도 **검색 결과가 없거나 10건 이하인 조건**에서 Timeout 발생

### Before

테이블 이름과 핵심 조건만 남긴 예시다. 연결 키와 상태 Column 이름은 공개용으로 단순화했다.

```sql
SELECT nh.notification_no,
       MAX(CASE WHEN nrh.status = 'SUCCESS' THEN 1 ELSE 0 END) AS is_success
FROM notification_history nh
LEFT JOIN notification_retry_history nrh
       ON nrh.notification_no = nh.notification_no
WHERE nh.event_time >= :from_time
  AND nh.event_time < :to_time
  -- 그 외 필수 검색조건 생략
GROUP BY nh.notification_no
ORDER BY nh.notification_no DESC
LIMIT :page_size;
```

### Step 1. JOIN과 GROUP BY 제거

- 조회할 때마다 재시도 이력을 JOIN·집계하지 않도록, 최종 상태를 `notification_history.status`에 `SUCCESS`·`FAIL`·`RETRY`로 저장
- 조회 Query에서 `notification_retry_history` JOIN과 `GROUP BY`를 제거하고 저장된 상태를 직접 읽음
- 필수·빈번한 검색조건과 Cardinality를 고려해 Index를 재구성하여 Table Access 감소

```sql
SELECT nh.notification_no,
       (nh.status = 'SUCCESS') AS is_success
FROM notification_history nh
WHERE nh.event_time >= :from_time
  AND nh.event_time < :to_time
  -- 그 외 필수 검색조건 생략
ORDER BY nh.notification_no DESC
LIMIT :page_size;
```

### Step 2. Index 순서로 정렬

조회에 사용한 기존 Index는 `event_time`이 선두 Column. 아래는 선두 Column만 표시한 개념 예시.

```text
기존 Index: (event_time, ...)
기존 정렬:  ORDER BY notification_no DESC
변경 정렬:  ORDER BY event_time DESC
```

- 1단계 이후에도 `ORDER BY notification_no DESC`는 `event_time` 선두 Index의 순서와 맞지 않아 Index 순서로 결과를 읽으며 정렬을 생략하거나, `LIMIT` 건수를 채운 시점에 조회를 조기 종료(early stop)할 수 없었음
- 검색 결과가 없거나 `LIMIT` 건수 미만인 조건에서는 필요한 행 수를 채우지 못해 조회 범위 전체를 확인해야 했고 Timeout이 계속 발생
- `event_time`은 필수 `WHERE` 조건에 사용하며, 이 Query에서 `event_time DESC`도 필요한 최신순을 표현함. 정렬의 선두 Column을 `notification_no`에서 `event_time`으로 바꿔 Index 순서로 결과를 읽도록 수정

```sql
SELECT nh.notification_no,
       (nh.status = 'SUCCESS') AS is_success
FROM notification_history nh
WHERE nh.event_time >= :from_time
  AND nh.event_time < :to_time
  -- 그 외 필수 검색조건 생략
ORDER BY nh.event_time DESC
LIMIT :page_size;
```

### Result

- 반복 계산을 Write 시점으로 이동해 조회 시점의 대용량 JOIN·집계를 제거하고, Index 순서를 활용해 별도 정렬 작업 생략
- **10초 Timeout → 평균 약 1초**. 1단계 후에도 남았던 소수·무결과 조회의 Timeout을 2단계 정렬 조건 변경으로 개선

## Case 3. 이벤트 조회의 제외·포함 조건 최적화

### Data Scale

- Event 약 **450만 건**
- Server 약 **24만 건**

### Problem

- 제외 대상으로 등록된 서비스의 이벤트는 검색 결과에서 빼고, 모니터링 그룹에 속한 서버에서 발생한 이벤트는 포함해야 함
- 이벤트 조회 Query 실행 시간이 **10초 이상** 걸려 웹 요청 Timeout 발생
- Event 한 건은 서버 한 대를 가리키지만, 서버 한 대는 **1~50개 서비스**에 속할 수 있음. `event.target_id = server.server_id`로 JOIN한 뒤 서비스 정보를 결합하면 이벤트 한 건에서 여러 행이 만들어질 수 있음
- 제외 서비스 판별은 `server`와 `exclusive_service`를 `LEFT JOIN`한 뒤 `IS NULL`로 걸렀고, 모니터링 그룹 서버 판별은 `IN` 서브쿼리로 처리

### Before

`event.target_id`와 `server.server_id`의 연결은 실제 조회 구조를 반영했다. 공개할 수 없는 서비스 매칭 조건과 모니터링 그룹 소속 조건은 생략한 의사 SQL이다.

```sql
FROM event e
LEFT JOIN server s
       ON s.server_id = e.target_id
LEFT JOIN exclusive_service xs
       ON <server와 exclusive_service의 매칭 조건>
WHERE xs.<식별자> IS NULL
  AND (
      <다른 이벤트 포함 조건>
      OR e.target_id IN (
          SELECT ms.server_id
          FROM server ms
          WHERE <모니터링 그룹 소속 조건>
      )
  )
```

### Analysis

- 한 이벤트 → 한 서버 → 서비스 1~50개로 이어지는 관계에서 서비스 정보를 JOIN하면, 이벤트 한 건에 대한 중간 행이 최대 50개까지 늘어날 수 있음. 필요한 것은 서비스 행이 아니라 해당 서버에 **제외 서비스가 존재하는지** 여부
- `LEFT JOIN ... IS NULL`로 표현한 제외 조건을 `NOT EXISTS`로 바꿔, `event.target_id`에 연결된 서버가 제외 서비스에 속하는지 이벤트 한 건 단위로 판별
- 모니터링 그룹 조건도 서버 행을 결과에 붙이려는 것이 아니라, **이벤트가 발생한 서버가 그룹에 속하는지** 확인하는 조건이다. `IN`을 `EXISTS`로 바꿔 `server.server_id = event.target_id`로 연결된 서버에서 매칭되는 행의 존재 여부만 확인

### After

```sql
FROM event e
WHERE NOT EXISTS (
    SELECT 1
    FROM server s
    JOIN exclusive_service xs
      ON <server와 exclusive_service의 매칭 조건>
    WHERE s.server_id = e.target_id
)
  AND (
      <다른 이벤트 포함 조건>
      OR EXISTS (
          SELECT 1
          FROM server ms
          WHERE ms.server_id = e.target_id
            AND <모니터링 그룹 소속 조건>
      )
  )
```

### Result

- 서버의 서비스 소속 수와 관계없이, 제외 서비스가 연결된 서버의 이벤트는 `NOT EXISTS`로 걸러 내고 모니터링 그룹 서버의 이벤트는 `EXISTS`로 포함
- 한 서버에 서비스가 1~50개 연결되어 있어도 존재 여부를 확인하는 과정에서 이벤트 행이 서비스 수만큼 늘어나지 않도록 변경
- 이 쿼리의 실행 시간은 **10초 이상 Timeout → 약 1초**로 개선
- 실행 시간은 전체 쿼리의 전후 결과이며, 두 조건 변경 각각의 기여도는 별도로 측정하지 않음

## Technical Decisions

- **기존 Index 우선:** 복합 Index의 Column 순서와 검색조건을 비교하고 업무조건 변경 가능성 확인
- **Read 비용 제거:** 반복되는 JOIN / `GROUP BY`를 저장 시점의 결과 계산으로 대체
- **검색과 정렬의 Index 활용:** 필수 조건인 `event_time`으로 최신순 정렬해 별도 정렬 작업 제거
- **제외·포함 조건을 존재 여부로 표현:** 제외 서비스는 `NOT EXISTS`, 모니터링 그룹 서버는 이벤트와 연결된 `EXISTS`로 확인

## Lessons Learned

- 실행계획의 Index Access 방식과 JOIN·집계·정렬 비용을 함께 분석
- SQL 문법뿐 아니라 데이터 모델과 Read / Write 계산 시점을 포함해 최적화 범위 판단
- 제외할 대상과 포함할 대상을 구분하고, 필요한 존재 여부를 Query에 직접 표현
