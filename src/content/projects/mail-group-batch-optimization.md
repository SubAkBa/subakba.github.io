---
title: "메일 그룹 동기화 배치 성능 개선"
company: "N Tech Service"
category: "Batch Performance"
summary: "배치의 계층 사전 가공을 없애고 Paging 기반 관계 동기화와 조회 시점의 Recursive CTE로 책임을 나눠, 사원 정보 약 50만 건 규모의 운영 환경에서 수행시간을 2시간에서 약 50초로 단축"
skills:
  - Java
  - Spring Boot
  - Spring Batch
  - MySQL
  - MyBatis
  - jOOQ
featured: true
order: 6
draft: false
---

외부 시스템의 메일 그룹(DL, Distribution List)과 멤버 관계를 매일 동기화하는 배치에서 계층 사전 가공을 제거하고 관계 동기화와 조회 시점의 계층 해석으로 책임을 나눴다. **사원 정보 약 50만 건 규모의 운영 환경에서 배치 수행시간 2시간 → 약 50초**. 이 규모는 사원 정보 데이터에 대한 것으로, 동기화한 멤버 관계 건수와는 구분한다.

## 개선 흐름

<ol class="project-journey" aria-label="메일 그룹 동기화 개선 단계">
  <li><strong>01 · 병목 분석</strong><span>전체 적재·반복 탐색·멤버별 DB 접근</span></li>
  <li><strong>02 · 배치 동기화</strong><span>Paging Chunk·원본 관계 저장·오래된 관계 정리</span></li>
  <li><strong>03 · 조회 책임 이동</strong><span>필요한 시점에 Recursive CTE로 하위 멤버 조회</span></li>
</ol>

아래 탭에서 기존 구조의 비용, 배치 변경, Backend API의 계층 조회와 설계상 교환 비용을 순서대로 볼 수 있다.

## Stage 1. 전체 적재와 계층 사전 가공의 병목

DL의 멤버는 사원일 수도, 다른 DL일 수도 있다. 기존 배치는 계층을 미리 펼쳐 최종 사원 관계를 저장했고 Backend API는 그 결과를 단순 조회했다.

### 원본 관계와 기존 처리 흐름

`DL`은 `DL_CD`를 키로 관리한다. 멤버 관계는 `DL_CD + MEMBER_CD`를 키로 하며, `MEMBER_CD`에는 사번 또는 하위 DL 코드가 들어갈 수 있다.

```text
DL-A
├── EMP-001
├── DL-B
│   ├── EMP-002
│   └── DL-D → EMP-004, EMP-005
└── DL-C
    ├── EMP-003
    └── DL-E
        ├── EMP-006
        └── DL-F → EMP-007, EMP-008
```

기존 Tasklet은 동기화 대상 멤버 관계를 `List<Member>`에 한 번에 적재했다. 이후 대상 데이터를 전체 삭제하고, 각 Member에 대해 Java 재귀로 하위 관계를 펼쳐 저장했다.

이 절의 Java 코드는 기존 처리 흐름의 핵심만 남긴 공개용 예시다.

```java
List<Member> memberList = memberRepository.selectAllMemberList();

mailingGroupRepository.deleteAllMember();

for (Member member : memberList) {
    insertMemberRecursively(member, memberList, 0);
}
```

### 재귀 단계마다 전체 List 반복 탐색

하위 DL을 만나면 현재 DL에 속한 멤버를 찾기 위해 전체 `memberList`를 다시 순회했다. 관계를 그룹별 Map이나 Index로 묶어 두지 않았으므로, 탐색할 DL이 늘어날수록 동일한 List를 훑는 비용이 누적됐다. 비용을 키운 것은 재귀 호출 자체보다 **재귀의 각 단계에서 관계를 찾는 방식**이었다.

```java
for (Member member : paramMemberList) {
    if (StringUtils.equals(memberCode, member.getDlCode())) {
        filterMemberList.add(member);
    }
}
```

하위 DL을 만나면 **같은 메서드를 다시 호출**하고, 그 그룹의 탐색이 끝나면 이전 호출로 돌아와 다음 멤버를 처리했다. 다음은 DL-A를 시작점으로 한 호출 순서의 개념 예시다.

```text
insertMemberRecursively(DL-A, depth=0)
  ├─ insertMemberRecursively(DL-B, depth=1)
  │    └─ insertMemberRecursively(DL-D, depth=2)
  │         ↶ DL-D 종료 → DL-B 종료 → DL-A로 복귀
  └─ insertMemberRecursively(DL-C, depth=1)
       └─ insertMemberRecursively(DL-E, depth=2)
            └─ insertMemberRecursively(DL-F, depth=3)
                 ↶ 이전 호출로 차례로 복귀
```

아래 애니메이션은 **13개 관계의 설명용 데이터**로 이 호출 스택의 진입·복귀와 매 호출의 전체 List 재탐색을 보여 준다. 개선 후에는 Batch가 이 호출 스택을 만들지 않고 원본 관계를 저장하며, 계층 해석은 API 조회 시점에 수행한다.

<div id="mail-group-animation-slot"></div>

### 최종 멤버마다 DB 접근

재귀 끝에서 사원 또는 외부 메일을 만나면 대상 테이블에 해당 멤버가 있는지 `SELECT`하고, 없을 때 `INSERT`했다. 이미 전체 삭제를 수행한 뒤이므로 이 확인은 이전 실행에서 남은 행을 재사용하기 위한 조회가 아니다. 매번 전체 관계를 다시 가공하면서 최종 멤버마다 DB 접근이 발생했다.

```java
int count = mailingGroupRepository.selectMemberCount(member);
if (count == 0) {
    mailingGroupRepository.insertMember(member);
}
```

전체 적재에 따른 JVM 메모리 부담, Java 재귀 호출 중 하위 관계마다 반복되는 전체 List 탐색, 최종 멤버별 DB 접근이 함께 누적되는 구조였다. 같은 서버에서 다른 배치 잡도 실행됐으므로 애플리케이션 부하를 줄일 필요가 있었다.

## Stage 2. Paging Chunk로 원본 관계 동기화

배치의 책임을 계층 결과 생성에서 **외부 시스템의 원본 `DL_CD / MEMBER_CD` 관계 동기화**로 바꿨다. 계층 해석을 위한 Java 재귀를 Batch에서 제거하고, 관계 데이터를 일정 단위로 읽고 쓴다.

### Reader와 Writer 구성

`JdbcPagingItemReader`의 `pageSize`와 Chunk의 `chunkSize`를 각각 **10,000건**으로 설정하고 MyBatis Writer에 전달했다. 계층 사전 가공이 사라져 별도의 Processor는 두지 않았다.

```text
외부 Member 관계
  → JdbcPagingItemReader (pageSize = 10,000)
  → Chunk (chunkSize = 10,000)
  → MyBatis Writer
  → 원본 DL_CD / MEMBER_CD 관계 저장
```

이 작업처럼 많은 관계를 순차적으로 읽고 저장할 때는 Chunk와 Paging을 통해 한 번에 다루는 데이터 양과 트랜잭션 범위를 정할 수 있다. Tasklet과 Chunk의 일반적인 우열보다, 전체 적재가 필요 없어진 작업 형태에 맞춘 변경이었다.

### 전체 삭제 대신 키 기준 갱신

기존의 전체 `DELETE` 후 재생성 방식을 `DL_CD + MEMBER_CD` 키에 대한 MySQL `INSERT ... ON DUPLICATE KEY UPDATE`로 변경했다. 아래 SQL은 **키와 갱신 시각만 보여 주는 공개용 개념 예시**다. 실제 저장 컬럼과 조건은 생략했다.

```sql
INSERT INTO MEMBER (DL_CD, MEMBER_CD, MOD_YMDT)
VALUES (:dlCode, :memberCode, NOW())
ON DUPLICATE KEY UPDATE
    MOD_YMDT = NOW();
```

이번 실행에서 처리한 관계는 `MOD_YMDT`가 갱신된다. 모든 페이지의 동기화가 끝난 뒤 이번 실행에서 갱신되지 않은 관계를 정리한다. 전체 삭제 후 재생성을 피하지만, 동일한 키의 행도 Upsert 대상이므로 **변경된 행만 골라 쓰는 방식은 아니다.**

```text
이번 실행에 존재하는 관계 → 키 기준 Upsert → MOD_YMDT 갱신

이번 실행에서 사라진 관계 → Upsert 대상 아님 → MOD_YMDT 미갱신
                                            → 동기화 완료 후 삭제
```

전체 데이터를 먼저 비우지 않고, 원본의 현재 관계를 키 기준으로 반영한 다음 사라진 관계를 정리하는 구조다. 위 그림은 처리 순서만 나타내며, 삭제 대상의 실제 판별 조건과 배치 실패 시 처리 방식까지 표현하지는 않는다.

## Stage 3. 필요한 조회에서만 계층 해석

배치가 더 이상 하위 사원을 미리 펼치지 않으므로, 특정 DL의 실제 사원 목록이 필요한 Backend API가 조회 시점에 관계를 해석한다.

### Recursive CTE와 최종 사원 조회

요청 티켓의 참조자로 DL이 등록된 경우, 현재 사용자가 해당 DL의 멤버인지 확인할 때 이 조회를 사용한다. jOOQ의 `withRecursive`로 시작 DL의 멤버를 찾고, 발견한 하위 DL의 멤버를 반복 탐색한다. 반환된 코드는 재직 중인 사원 정보 조회에 사용한다.

```sql
-- 실제 jOOQ 구현의 탐색 흐름을 나타낸 개념 SQL
WITH RECURSIVE cte (DL_CD, MEMBER_CD, depth) AS (
    SELECT DL_CD, MEMBER_CD, 0
    FROM MEMBER
    WHERE DL_CD = :dlCode

    UNION ALL

    SELECT child.DL_CD, child.MEMBER_CD, cte.depth + 1
    FROM MEMBER child
    JOIN cte ON child.DL_CD = cte.MEMBER_CD
    WHERE cte.depth < 12
)
SELECT MEMBER_CD FROM cte;
```

jOOQ 구현에는 `depth < 12` 조건이 있고, 기존 Java 구현에는 `depth == 11`에서 반환하는 조건이 있었다. 위 개념 SQL처럼 Anchor의 깊이를 0으로 두고 재귀부에서 깊이가 12 미만인 행만 확장하면 **깊이 12인 행까지 생성될 수 있다**. 두 제한의 수치만으로 결과 범위가 같다고 단정할 수 없으며, Java 제한이 추가된 배경도 확인되지 않는다.

### 계산 시점의 교환 비용

| 구분 | 기존 | 개선 |
| --- | --- | --- |
| Batch | 매일 전체 계층을 미리 해석·저장 | 원본 관계를 Paging으로 동기화 |
| Backend API | 미리 펼친 데이터 단순 조회 | 필요한 요청에서 Recursive CTE 실행 |

Backend API 조회에는 재귀 쿼리 비용이 추가된다. 다만 이 조회는 요청 티켓의 참조자 DL 멤버 확인에 쓰이며 모든 API 요청에서 실행되지는 않는다. 운영에서 비교했을 때 기존 단순 SELECT와 Recursive CTE의 응답시간 차이는 크지 않았다. 매일 실행하는 배치의 반복적인 계층 가공을 제거하는 편이 전체 시스템에 유리하다고 판단했다. **DB 재귀가 Java 재귀보다 일반적으로 빠르다는 결론은 아니다.**

### 개선 결과

| 구분 | 기존 | 개선 |
| --- | --- | --- |
| 데이터 조회 | 전체 적재 | 10,000건 단위 Paging |
| 계층 처리 | Batch의 Java 재귀·전체 List 반복 탐색 | Batch에서 제거, 필요 시 API의 Recursive CTE |
| 저장·삭제 | 전체 DELETE 후 재생성, 멤버별 존재 확인 | 키 기준 Upsert 후 미갱신 관계 삭제 |
| 배치 수행시간 | 2시간 | 약 50초 |

사원 정보 약 50만 건 규모의 운영 환경에서 확인한 배치 수행시간은 **2시간 → 약 50초**였다. 사원 정보 규모는 배치가 읽은 멤버 관계 건수와 구분해야 한다. Paging, 계층 사전 가공과 멤버별 DB 접근 제거, 저장·삭제 방식 변경을 함께 적용한 전후 결과이며, 각 변경의 기여 시간은 분리해 측정하지 않았다.

배치는 관계를 정확하고 효율적으로 동기화하고, Backend API는 실제 필요한 순간에 계층을 해석하도록 책임을 나눴다. 이번 개선의 핵심은 문법 교체보다 **데이터 가공 시점과 책임의 재설계**였다.
