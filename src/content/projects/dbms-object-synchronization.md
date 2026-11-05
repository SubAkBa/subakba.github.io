---
title: "DBMS 오브젝트 동기화 구조 개선"
company: "N Tech Service"
category: "Architecture Refactoring"
summary: "여러 DBMS의 오브젝트 동기화에서 JDBC 실행 흐름과 DBMS별 처리 로직을 분리하고, Registry와 조합 구조로 확장 시 변경 범위를 줄인 설계"
skills:
  - Java
  - Spring Boot
  - JDBC
  - Design Patterns
featured: true
order: 8
draft: false
---

여러 DBMS와 오브젝트 유형을 지원하는 동기화 기능에서 공통 JDBC 처리와 DBMS별 로직이 섞여 있었다. 실행 흐름은 재사용하고, DBMS·오브젝트마다 달라지는 부분은 독립적인 구현체로 분리했다.

## 작업 배경

담당 시스템에서는 MySQL, Oracle, PostgreSQL, MSSQL, Cubrid 및 사내 DBMS 등 여러 데이터베이스의 오브젝트 정보를 동기화하는 기능을 제공하고 있었다.

동기화 대상에는 Table, Column, Index, Sequence, View, Synonym 등 다양한 오브젝트가 포함되었으며, DBMS마다 지원하는 오브젝트 종류와 메타데이터 조회 방식이 달랐다.

기존에는 이러한 차이를 처리하기 위해 DBMS별 동기화 로직을 각각 구현하고 있었다.

하지만 실제 동기화 과정을 분석해 보면 대부분 동일한 JDBC 실행 흐름을 사용하고 있었다.

- `Connection`을 통한 데이터베이스 연결
- `Statement`를 통한 메타데이터 조회 SQL 실행
- `ResultSet`을 통한 조회 결과 처리
- JDBC 자원 해제

반면 DBMS마다 달라지는 부분은 다음과 같았다.

- 오브젝트별 메타데이터 조회 SQL
- 조회 결과를 내부 오브젝트 모델에 매핑하는 로직
- DBMS별 오브젝트 속성 및 설정값 처리
- DBMS별 지원 오브젝트 종류

즉, **JDBC 실행 흐름은 공통적이지만, 오브젝트를 조회하고 해석하는 비즈니스 로직은 DBMS마다 달랐다.**

기존 구조에서는 이러한 공통 로직과 DBMS별 비즈니스 로직이 혼재되어 있어 중복 코드가 발생했고, 신규 DBMS 및 오브젝트를 추가할 때 기존 코드를 수정해야 하는 문제가 있었다.

이를 해결하기 위해 **Template Method, Strategy, Composition 및 Registry 구조를 활용하여 DBMS 오브젝트 동기화 구조를 재설계했다.**

## 기존 구조의 문제점

### JDBC 자원 관리 코드 중복 및 자원 누수 위험

기존에는 DBMS별 동기화 로직에서 JDBC 자원을 직접 생성하고 해제했다.

```java
Connection conn = getConnection();
Statement stmt = conn.createStatement();
ResultSet rs = stmt.executeQuery(sql);

// DBMS별 메타데이터 조회 및 설정 로직

rs.close();
stmt.close();
conn.close();
```

이러한 구조에는 다음과 같은 문제가 있었다.

- DBMS별 동기화 구현체마다 JDBC 자원 처리 코드 중복
- JDBC 자원 관리 정책 변경 시 여러 구현체 수정 필요
- 비즈니스 로직과 JDBC 자원 관리 책임 혼재
- 일부 구현에서 `close()` 누락
- 예외 발생 시 JDBC 자원이 해제되지 않을 가능성

특히 `try-with-resources`나 `finally`를 통한 자원 해제 보장이 없는 코드에서는 SQL 실행 또는 결과 처리 도중 예외가 발생하면 이후 `close()`가 호출되지 않을 수 있었다.

이는 데이터베이스 연결 등의 자원 누수로 이어질 위험이 있었다.

### DBMS별 구현체 선택을 위한 조건문

기존에는 오브젝트별 동기화 API에서 DBMS 코드를 비교하여 해당 DBMS의 구현체를 선택했다.

```java
if (dbmsCode.equals("ORACLE")) {
    oracleProcessor.syncTable(...);
} else if (dbmsCode.equals("MYSQL")) {
    mysqlProcessor.syncTable(...);
} else if (dbmsCode.equals("POSTGRESQL")) {
    postgresqlProcessor.syncTable(...);
}
```

동기화 API는 오브젝트 종류별로 구분되어 있었지만, 각 API에서는 DBMS에 따라 서로 다른 구현체를 호출해야 했다.

따라서 신규 DBMS가 추가되면 해당 DBMS를 처리하기 위한 조건문도 추가해야 했다.

또한 DBMS마다 지원하는 오브젝트 종류가 다르다는 점도 고려해야 했다.

예를 들어 Table, Column, Index는 모든 DBMS에서 지원하지만 Sequence, View, Synonym 등은 일부 DBMS에서만 지원했다.

이러한 구조에서는 **구현체를 선택하는 로직과 실제 동기화 비즈니스 로직이 강하게 결합되어 변경 범위가 넓어지는 문제**가 있었다.

### 새로운 기능 추가에 따른 변경 범위 증가

기존 구조에서는 변경 유형에 따라 여러 영역을 함께 수정해야 했다.

| 변경 유형 | 기존 구조의 문제 |
|---|---|
| 신규 DBMS 추가 | DBMS 분기 조건 및 동기화 구현 추가 |
| 신규 오브젝트 추가 | 오브젝트별 호출 로직과 지원 DBMS 구현 추가 |
| JDBC 실행 방식 변경 | 여러 DBMS의 중복 코드 수정 |
| 오브젝트 설정 로직 변경 | 해당 DBMS의 동기화 구현 수정 |

이러한 문제를 해결하기 위해 공통 실행 흐름과 DBMS별 구현을 분리하고, 각 기능을 독립적으로 확장할 수 있는 구조가 필요했다.

## 개선 방향

기존 구조를 분석한 후 다음과 같이 개선 방향을 설정했다.

1. **JDBC 실행 흐름 공통화:** JDBC 실행 및 자원 관리를 추상 클래스로 통합
2. **Template Method 적용:** 공통 실행 순서는 상위 클래스에서 정의하고 DBMS별 세부 로직만 하위 클래스에서 구현
3. **오브젝트 동기화 기능 분리:** Table, Index, Sequence 등 오브젝트별 동기화 구현체 분리
4. **Composition 적용:** DBMS별 Synchronizer가 지원하는 오브젝트 동기화 구현체만 보유
5. **Registry 도입:** Spring Bean과 Map을 활용하여 DBMS별 구현체 선택 로직 중앙화
6. **JDBC 자원 관리 개선:** `try-with-resources`를 적용하여 예외 발생 시 자원 해제 보장

핵심은 **공통 실행 흐름은 재사용하고, DBMS 및 오브젝트별 차이는 독립적인 구현체로 분리하는 것**이었다.

## 개선 구조

### DBMS와 오브젝트별 동기화 책임 분리

기존의 DBMS별 동기화 로직을 다음과 같이 역할별로 분리했다.

<figure class="project-diagram">
  <a href="/images/projects/dbms-object-synchronization/architecture.png" target="_blank" rel="noopener noreferrer" aria-label="DBMS 오브젝트 동기화 전체 설계도 원본 크기로 보기">
    <img src="/images/projects/dbms-object-synchronization/architecture.png" alt="DBMS Registry, DBMS별 Synchronizer, 오브젝트별 Synchronizer와 공통 JDBC Template Method의 관계를 보여주는 설계도" width="1536" height="1024" loading="lazy" />
  </a>
  <figcaption>DBMS와 오브젝트별 동기화 구조 · 이미지를 선택하면 원본 크기로 볼 수 있다.</figcaption>
</figure>

```text
Controller / Service
        │
        ▼
DbmsRegistry
        │
        ▼
DbmsSynchronizer
        │
        ├── OracleSynchronizer
        │       ├── OracleTableSynchronizer
        │       ├── OracleIndexSynchronizer
        │       └── OracleSequenceSynchronizer
        │
        ├── MySqlSynchronizer
        │       ├── MySqlTableSynchronizer
        │       └── MySqlIndexSynchronizer
        │
        └── PostgreSqlSynchronizer
                ├── PostgreSqlTableSynchronizer
                └── PostgreSqlSequenceSynchronizer

ObjectSynchronizer
        ▲
        │
AbstractObjectSynchronizer
        ▲
        │
        ├── OracleTableSynchronizer
        ├── MySqlTableSynchronizer
        ├── PostgreSqlTableSynchronizer
        └── ...
```

각 구성 요소의 책임은 다음과 같다.

| 구성 요소 | 역할 |
|---|---|
| DbmsRegistry | DBMS 타입에 해당하는 Synchronizer 조회 |
| DbmsSynchronizer | DBMS별 동기화 기능의 공통 계약 |
| OracleSynchronizer 등 | 지원하는 오브젝트 동기화 구현체를 관리하고 실행 위임 |
| ObjectSynchronizer | 오브젝트 동기화 기능의 공통 계약 |
| AbstractObjectSynchronizer | JDBC 실행 흐름 및 자원 관리 |
| OracleTableSynchronizer 등 | DBMS 및 오브젝트별 메타데이터 조회·설정 |

이를 통해 사용처에서는 구체적인 DBMS별 구현체를 직접 알 필요 없이 공통 인터페이스를 통해 동기화를 요청할 수 있도록 구성했다.

### Template Method를 활용한 JDBC 실행 흐름 공통화

DBMS별로 반복되는 JDBC 실행 흐름을 `AbstractObjectSynchronizer` 추상 클래스로 통합했다.

공통 실행 흐름은 상위 클래스에서 정의하고, DBMS마다 달라지는 SQL 생성 및 결과 처리 로직은 추상 메서드로 분리했다.

구조를 단순화하면 다음과 같다.

```java
public abstract class AbstractObjectSynchronizer
        implements ObjectSynchronizer {

    @Override
    public void sync(Connection connection) throws SQLException {
        String sql = getQuery();

        try (
            Statement stmt = connection.createStatement();
            ResultSet rs = stmt.executeQuery(sql)
        ) {
            syncObject(rs);
        }
    }

    protected abstract String getQuery();

    protected abstract void syncObject(ResultSet rs)
            throws SQLException;
}
```

위 예시는 호출자가 `Connection`을 전달하고 연결 생명주기를 관리하는 구조를 가정했다. 실제 코드의 연결 소유 및 해제 책임은 해당 실행 범위에 맞게 적용했다.

이 구조에서 `sync()`는 실행 흐름을 정의하는 Template Method 역할을 한다.

실행 순서는 다음과 같다.

1. `getQuery()`를 호출하여 DBMS별 SQL 생성
2. `Statement`를 이용하여 SQL 실행
3. `syncObject()`를 호출하여 DBMS별 결과 처리
4. `try-with-resources`를 통한 JDBC 자원 해제

하위 클래스는 공통 실행 흐름을 다시 구현하지 않고, DBMS별로 달라지는 메서드만 오버라이딩한다.

예를 들어 Oracle과 MySQL의 Table 동기화 구현은 다음과 같이 구성할 수 있다.

```java
public class OracleTableSynchronizer
        extends AbstractObjectSynchronizer {

    @Override
    protected String getQuery() {
        // Oracle 전용 Table 메타데이터 조회 SQL
    }

    @Override
    protected void syncObject(ResultSet rs)
            throws SQLException {
        // Oracle 전용 Table 속성 및 설정 처리
    }
}
```

```java
public class MySqlTableSynchronizer
        extends AbstractObjectSynchronizer {

    @Override
    protected String getQuery() {
        // MySQL 전용 Table 메타데이터 조회 SQL
    }

    @Override
    protected void syncObject(ResultSet rs)
            throws SQLException {
        // MySQL 전용 Table 속성 및 설정 처리
    }
}
```

두 클래스 모두 동일한 `sync()` 흐름을 사용하지만 SQL과 메타데이터 처리 방식은 서로 다르다.

이를 통해 **JDBC 실행 흐름을 수정할 때는 공통 추상 클래스만 변경하고, DBMS별 비즈니스 로직을 수정할 때는 해당 구현체만 변경**할 수 있도록 구성했다.

또한 기존에 명시적으로 호출하던 `close()`를 `try-with-resources`로 변경하여 SQL 실행 또는 결과 처리 도중 예외가 발생하더라도 관리 대상 JDBC 자원이 해제되도록 개선했다.

### Composition을 활용한 DBMS별 지원 오브젝트 구성

DBMS마다 지원하는 오브젝트가 다르다는 점을 고려하여 오브젝트별 동기화 구현체를 분리했다.

그리고 각 DBMS의 Synchronizer는 자신이 지원하는 오브젝트 동기화 구현체를 조합하여 사용하도록 구성했다.

```java
public interface DbmsSynchronizer {
    void sync(ObjectType objectType, Connection connection)
            throws SQLException;
}
```

Oracle의 경우 다음과 같이 구성할 수 있다.

```java
@Component
public class OracleSynchronizer
        implements DbmsSynchronizer {

    private final Map<ObjectType, ObjectSynchronizer> synchronizers;

    public OracleSynchronizer() {
        synchronizers = Map.of(
            ObjectType.TABLE, new OracleTableSynchronizer(),
            ObjectType.INDEX, new OracleIndexSynchronizer(),
            ObjectType.SEQUENCE, new OracleSequenceSynchronizer()
        );
    }

    @Override
    public void sync(
            ObjectType objectType,
            Connection connection
    ) throws SQLException {

        ObjectSynchronizer synchronizer =
                synchronizers.get(objectType);

        if (synchronizer == null) {
            throw new IllegalArgumentException(
                "Unsupported object type: " + objectType
            );
        }

        synchronizer.sync(connection);
    }
}
```

*위 코드는 Composition 구조를 설명하기 위한 예시이며, 실제 구현체 생성·주입 방식과 예외 처리 방식은 단순화했다.*

이 구조에서는 `OracleSynchronizer`가 모든 오브젝트 동기화 로직을 직접 구현하지 않는다.

대신 Table, Index, Sequence 등 각 오브젝트에 해당하는 Synchronizer를 보유하고, 요청한 오브젝트 타입에 따라 적절한 구현체에 작업을 위임한다.

이러한 방식은 **상속을 통해 모든 기능을 하나의 클래스에 구현하는 대신, 필요한 기능을 조합하여 사용하는 Composition 구조**다.

또한 각 오브젝트 Synchronizer는 공통 계약을 따르면서 DBMS별로 다른 동기화 알고리즘을 제공하므로 Strategy 패턴의 특성을 갖는다.

실제 시스템에서는 DBMS마다 지원하는 오브젝트의 차이도 존재했다.

| DBMS | 공통 지원 | 추가 지원 오브젝트 |
|---|---|---|
| MySQL | Table, Column, Index | View |
| Oracle | Table, Column, Index | Serial/Sequence, View, SP, Function, Trigger, Synonym |
| PostgreSQL | Table, Column, Index | Serial, SP, Trigger |
| MSSQL | Table, Column, Index | Trigger, Synonym |
| 사내 DBMS | Table, Column, Index | View |
| Cubrid | Table, Column, Index | Serial |

각 DBMS Synchronizer는 실제 지원하는 오브젝트 동기화 구현체만 보유하도록 구성했다.

이를 통해 지원하지 않는 오브젝트를 처리하기 위한 불필요한 메서드를 구현할 필요가 없어졌다.

또한 화면에서는 DBMS별 지원 오브젝트를 기준으로 선택할 수 없는 항목을 비활성화하여 사용자가 지원하지 않는 동기화 기능을 요청하지 않도록 처리했다.

### Spring Bean과 Registry를 활용한 DBMS 선택 로직 개선

기존에는 동기화 API에서 DBMS 코드를 비교하여 구체적인 Processor를 선택했다.

```java
if (dbmsCode.equals("ORACLE")) {
    oracleProcessor.sync(...);
} else if (dbmsCode.equals("MYSQL")) {
    mysqlProcessor.sync(...);
}
```

이를 개선하기 위해 DBMS별 Synchronizer를 Spring Bean으로 등록하고, 별도 Registry에서 관리하도록 변경했다.

```java
@Component
public class DbmsRegistry {

    private final Map<DbmsType, DbmsSynchronizer> synchronizers;

    public DbmsRegistry(List<DbmsSynchronizer> processors) {
        this.synchronizers = processors.stream()
            .collect(Collectors.toMap(
                this::resolveDbmsType,
                Function.identity()
            ));
    }

    public DbmsSynchronizer get(DbmsType dbmsType) {
        DbmsSynchronizer synchronizer =
                synchronizers.get(dbmsType);

        if (synchronizer == null) {
            throw new IllegalArgumentException(
                "Unsupported DBMS: " + dbmsType
            );
        }

        return synchronizer;
    }

    private DbmsType resolveDbmsType(
            DbmsSynchronizer synchronizer
    ) {
        // 구현체에 대응하는 DBMS 타입 반환
    }
}
```

Spring에서 등록한 구현체들을 주입받아 DBMS 타입을 Key로 사용하는 Map을 구성하는 방식이다.

이를 통해 DBMS 선택을 위한 조건문을 Registry 내부의 조회 로직으로 대체했다.

호출부에서는 다음과 같이 사용할 수 있다.

```java
DbmsSynchronizer synchronizer =
        dbmsRegistry.get(dbmsType);

synchronizer.sync(objectType, connection);
```

이 구조에서 `DbmsRegistry`는 DBMS별 구현체를 조회하여 제공하는 Factory/Registry 역할을 담당한다.

또한 사용처는 `OracleSynchronizer`, `MySqlSynchronizer`와 같은 구체 클래스를 직접 참조하지 않고 `DbmsSynchronizer` 인터페이스에 의존하도록 변경했다.

이를 통해 신규 DBMS를 추가할 때 기존 동기화 API의 조건문을 수정할 필요가 없어졌으며, 해당 DBMS의 구현체를 추가하고 Registry에 등록되도록 구성하면 된다.

## 개선 결과

### JDBC 실행 및 자원 관리 로직 공통화

DBMS별로 중복되어 있던 JDBC 실행 및 자원 관리 코드를 공통 추상 클래스로 통합했다.

또한 기존의 명시적인 `close()` 호출 방식을 `try-with-resources`로 변경하여 일부 자원 해제 누락 문제와 예외 발생 시 자원 누수 위험을 개선했다.

이를 통해 DBMS별 구현체는 SQL 생성 및 메타데이터 처리 등 실제 비즈니스 로직에 집중할 수 있게 되었다.

### DBMS별 조건문 제거

기존에 동기화 API에서 반복적으로 사용하던 DBMS 비교 조건문을 제거했다.

Spring Bean과 Map 기반 Registry를 도입하여 DBMS 타입에 맞는 Synchronizer를 조회하도록 변경했다.

호출부는 구체적인 DBMS 구현체를 알 필요 없이 공통 인터페이스만 사용하도록 개선했다.

### 신규 DBMS 및 오브젝트 확장성 개선

DBMS별 Synchronizer와 오브젝트별 Synchronizer를 분리하여 새로운 기능을 추가할 때 기존 코드의 변경 범위를 줄였다.

- 신규 DBMS 추가: DBMS별 Synchronizer 및 지원 오브젝트 구현체 추가
- 신규 오브젝트 추가: 해당 오브젝트를 지원하는 DBMS별 구현체 추가 및 구성
- JDBC 실행 방식 변경: 공통 추상 클래스 중심으로 수정
- 메타데이터 처리 변경: 해당 DBMS 및 오브젝트 구현체만 수정

특히 오브젝트별 동기화 기능을 독립적으로 구현하고 조합하는 구조로 변경하면서, 특정 DBMS의 변경이 다른 DBMS의 동기화 로직에 영향을 주지 않도록 책임을 분리했다.

### 유지보수성 및 변경 영향 범위 개선

개선 전에는 DBMS별 구현체에서 JDBC 자원 관리, SQL 실행, 메타데이터 처리 및 구현체 선택 로직이 분산되어 있었다.

개선 후에는 각 책임을 다음과 같이 분리했다.

- **AbstractObjectSynchronizer:** JDBC 실행 흐름 및 자원 관리
- **ObjectSynchronizer 구현체:** DBMS 및 오브젝트별 비즈니스 로직
- **DbmsSynchronizer 구현체:** DBMS별 지원 기능 구성 및 실행 위임
- **DbmsRegistry:** DBMS 타입에 따른 구현체 조회

이를 통해 변경 사항의 성격에 따라 수정해야 하는 코드의 위치를 명확히 구분할 수 있게 되었다.

## 정리

이번 작업에서는 여러 DBMS의 오브젝트 동기화 기능에서 발생하던 중복 코드와 DBMS별 구현체 선택 조건문을 개선하기 위해 전체 구조를 재설계했다.

Template Method 패턴으로 JDBC 실행 흐름을 공통화하고, `try-with-resources`를 도입하여 자원 관리의 안정성을 개선했다.

또한 DBMS별 Synchronizer가 지원하는 오브젝트 동기화 구현체를 조합하는 구조를 적용하여 DBMS와 오브젝트별 비즈니스 로직을 독립적으로 관리할 수 있도록 했다.

마지막으로 Spring Bean과 Map 기반 Registry를 도입하여 DBMS 선택 로직을 중앙화하고 호출부가 구체 구현체에 의존하지 않도록 변경했다.

결과적으로 **JDBC 자원 누수 위험을 줄이고, 공통 코드의 중복을 제거했으며, 신규 DBMS 및 오브젝트 추가에 따른 기존 코드의 변경 범위를 줄일 수 있는 구조로 개선했다.**