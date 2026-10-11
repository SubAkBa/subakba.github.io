---
title: "대용량 데이터 환경에서의 MySQL Query Performance Optimization"
company: "N Tech Service"
category: "Database Performance"
summary: "200만~3,000만 건 규모의 데이터 환경에서 인덱스, JOIN, 집계 및 정렬 구조를 분석하고 개선하여 주요 Query의 실행 시간을 단축한 사례"
skills:
  - MySQL
  - SQL
  - Query Optimization
  - Index
featured: true
order: 2
draft: false
---

## Performance Summary

| Case | Data Scale | Before | After |
| --- | --- | --- | --- |
| 복합 인덱스 활용 개선 | 약 3,000만 건 | 최대 약 50초 | 약 3초 |
| 대용량 JOIN / 집계 구조 개선 | 약 1,500만 + 2,000만 건 | 10초 이상 | 평균 약 3초 |
| JOIN 컬럼 타입 불일치 대응 | 약 200만 건 | 약 5초 | 1초 미만 |
| Anti Join / 정렬 구조 개선 | 약 450만 + 24만 건 | 약 6초 | 약 1초 |

각 사례는 서로 다른 Query와 데이터 규모를 대상으로 한다. 수치는 해당 사례에서 확인한 실행 시간이며, 서로 동일한 측정 조건의 비교값은 아니다. 아래 SQL과 Table·Column 이름은 구조를 설명하기 위해 일반화했다.

## Overview

서비스 운영 중 데이터 증가와 함께 일부 Batch 및 조회 API의 수행 시간이 늘어났다. 모니터링에서 발견한 Batch 지연, 웹 조회 Timeout, 사용자의 권한 조회 성능 제보, 대용량 검색 Timeout 등 문제를 발견한 경로도 달랐다.

대상 Table은 약 200만~3,000만 건 규모였다. 단순한 SQL 문법 변경보다 Query의 실행 구조와 기존 Index를 먼저 살펴보고, 필요한 경우 데이터 저장 구조까지 바꾸는 방식으로 개선했다. 여기서는 원인이 달랐던 네 가지 Query Tuning 사례를 정리한다.

## Case 1. 복합 인덱스 활용 개선

### Problem

약 3,000만 건의 IP 정보를 처리하는 Batch에서 특정 Query의 수행 시간이 과도하게 증가하는 현상을 모니터링으로 발견했다. 대상 Table에는 다음 형태의 복합 Index가 있었다.

```text
INDEX (a, b, c)
```

기존 검색 조건은 중간 Column인 `b`를 사용하지 않았다.

```sql
WHERE a = ?
  AND c = ?
```

이 조건으로는 `(a, b, c)` Index의 연속된 선두 Column을 충분히 검색 조건에 활용하기 어려웠다.

### Analysis

Query가 요구하는 데이터 범위를 다시 확인했다. `b`는 업무적으로 항상 검색 조건에 포함해도 결과의 의미가 바뀌지 않는 Column이었다. 새로운 Index를 추가하기 전에 기존 Index의 구성과 검색 조건을 맞출 수 있는지 검토했다.

### Solution

`b`를 검색 조건에 포함해 기존 복합 Index를 더 효율적으로 활용하도록 변경했다.

```sql
-- Before
WHERE a = ?
  AND c = ?;

-- After
WHERE a = ?
  AND b = ?
  AND c = ?;
```

### Result

약 3,000만 건의 데이터 환경에서 Query 실행 시간이 **최대 약 50초에서 약 3초**로 줄었다. Index를 추가하기 전에 실제 업무 조건과 기존 복합 Index의 Column 순서를 함께 확인한 사례다.

## Case 2. 대용량 JOIN / GROUP BY 제거와 데이터 구조 개선

### Problem

알림 히스토리 조회 Query가 조건에 따라 10초 이상 걸려 웹 요청 Timeout이 발생했다. 알림 히스토리는 약 1,500만 건, 알림 재시도 히스토리는 약 2,000만 건이었다.

기존에는 최종 전송 성공 여부를 확인하기 위해 두 Table을 JOIN하고 GROUP BY를 수행했다. 재시도 데이터 중 한 번이라도 전송 성공 기록이 있으면 해당 알림의 최종 결과를 성공으로 판단했다. 필수 검색 조건에 쓰이는 문자열 Column에 적절한 Index가 없는 문제도 있었다. 그 결과 조회할 때마다 대용량 JOIN과 동일한 집계가 반복됐다.

### Analysis

> 최종 전송 성공 여부를 조회할 때마다 재시도 히스토리를 집계해야 하는가?

최종 성공 여부는 데이터가 저장되는 시점에 결정할 수 있는 값이었다. 따라서 Read 시점마다 계산하는 대신 Write 시점에 결정해 저장하면 반복적인 집계 비용을 없앨 수 있다고 판단했다.

### Solution

알림 히스토리에 최종 전송 성공 여부를 저장하는 `success` Column을 추가하고, 히스토리를 저장할 때 그 값을 함께 기록하도록 구조를 변경했다.

```text
Before: READ → History + Retry History → JOIN → GROUP BY → 성공 여부 계산
After:  WRITE → 성공 여부 결정 및 History에 저장
        READ  → 저장된 success 조회
```

추가로 필수·빈번한 검색 조건, Column Cardinality, Table Access 감소 가능성을 고려해 Index를 재구성했다. 조회 과정에서 대용량 JOIN과 GROUP BY를 제거하고, 반복되던 계산을 저장 시점으로 옮겼다.

### Result

조건에 따라 **10초 이상** 걸리던 Query를 **평균 약 3초** 수준으로 개선했다. 이 사례의 핵심은 SQL 한 문장의 변경보다 조회 시점에 수행하던 계산 자체를 줄인 데 있다.

## Case 3. JOIN 컬럼 Data Type 불일치 대응

### Problem

약 200만 건 규모의 권한 정보 조회가 느리다는 사용자 제보가 있었다. 분석 결과 JOIN Key의 Data Type이 각각 `VARCHAR`와 `BIGINT`로 달랐다. 타입 불일치로 인해 JOIN에서 원하는 방식으로 Index를 활용하기 어려웠고, 기존 Query는 약 5초가 걸렸다.

### Analysis

JOIN Key의 타입을 통일하는 것이 근본적인 해결책이었다. 하지만 대상 Column은 기존 시스템의 PK와 관련돼 있어 변경 시 연관 기능과 시스템의 영향, 대용량 데이터 변경에 따른 DB 부하, 운영 환경의 변경 위험을 함께 고려해야 했다.

### Solution

당장 Schema를 변경하는 대신 WHERE 조건에 사용하는 Table을 바꿔 Driving Table이 달라지도록 Query를 수정했다. 현재 데이터 구조에서 기존 Index를 더 효과적으로 활용할 수 있는 실행 방향을 택한 것이다.

```text
장기적으로 검토할 방법: JOIN Key의 Data Type 통일
당시 적용한 방법:     현재 Schema 유지 + 검색 조건 및 Driving Table 변경
```

### Result

권한 정보 조회 시간을 **약 5초에서 1초 미만**으로 줄였다. 기술적으로 바람직한 Schema와 운영 시스템에서 안전하게 적용할 수 있는 변경 사이의 영향도를 고려해 결정했다.

## Case 4. Anti Join 및 정렬 구조 개선

### Problem

이벤트 검색 Query가 약 6초 걸려 웹 요청에서 Timeout이 발생했다. 당시 Event는 약 450만 건의 Driving Table, Server는 약 24만 건의 Driven Table이었다.

기존 Query는 Outer Join 후 Driven Table의 `IS NULL` 조건으로 대응 데이터가 없는 Event를 찾았다. 당시 실행계획에서는 Hash Join이 수행됐다. 최신 이벤트 순으로 보여주기 위해 `created_at`으로 정렬했지만, 이를 선두 Column으로 하는 적절한 Index가 없어 별도의 정렬 비용도 발생했다.

```sql
SELECT ...
FROM event e
LEFT JOIN server s ON ...
WHERE s.id IS NULL
ORDER BY e.created_at DESC;
```

### Analysis

요구사항은 **Server에 대응 데이터가 없는 Event를 최신순으로 조회**하는 것이었다. 존재하지 않는 데이터를 찾는 의도를 `NOT EXISTS`로 표현하는 방식을 검토했다. 또한 Event의 `event_id`는 생성 순서를 보장했고, 이를 선두 Column으로 하는 Index가 이미 있었다. 따라서 이 사례에서는 `event_id` 역순이 필요한 최신순과 같은 의미였다.

### Solution

Outer Join과 `IS NULL` 조건을 `NOT EXISTS`로 바꾸고, 정렬 기준을 기존 Index의 선두 Column인 `event_id`로 변경했다.

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

`NOT EXISTS`가 언제나 `LEFT JOIN ... IS NULL`보다 빠르다는 뜻은 아니다. 당시 데이터 구조와 실행계획을 확인해 Anti Join의 의도와 기존 Index를 함께 반영한 변경이다.

### Result

실행 시간이 **약 6초에서 약 1초**로 줄었다. 새로운 Index를 추가하지 않고 Query의 구조와 기존 Index의 정렬 특성을 활용했다.

## Lessons Learned

### 기존 Index와 Query 조건을 먼저 비교한다

성능 문제가 생겼을 때 Index를 바로 추가하기보다, 복합 Index의 Column 순서와 Query 조건을 먼저 비교했다. 업무적으로 조건을 보완할 수 있다면 기존 Index의 활용도를 높일 수 있다.

### 반복되는 Read 계산을 줄일 수 있는지 살펴본다

대용량 JOIN과 GROUP BY가 필요하다면 그 계산을 매번 Read 시점에 해야 하는지 검토한다. 결과를 Write 시점에 결정할 수 있다면 데이터 구조를 바꿔 반복적인 조회 비용을 줄일 수 있다.

### 운영 환경의 변경 비용을 고려한다

Schema 변경이 근본적인 해결책이어도 대용량 운영 데이터와 연관 시스템의 영향이 크다면 적용 위험을 함께 평가해야 한다. 성능 개선 효과와 변경 비용을 모두 고려해 방법을 선택했다.

### Query의 의미와 정렬 요구를 함께 확인한다

Anti Join의 의미를 명확히 표현하고, 업무적으로 동일한 결과 순서를 보장하는 기존 Index가 있는지도 확인했다. Query Tuning은 데이터 규모, 업무 요구사항, Index, 실행계획, 운영 환경을 함께 고려하는 과정이었다.
