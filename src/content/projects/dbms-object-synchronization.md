---
title: "DBMS 오브젝트 동기화 구조 개선"
company: "N Tech Service"
role: "문제 분석·설계·구현·검증 전반 담당"
category: "Architecture Refactoring"
summary: "공통 JDBC 흐름과 DBMS별 처리를 분리하고, DBMS 타입별 Map 조회와 지원 오브젝트 조합으로 변경 범위를 줄인 설계"
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

문제 분석부터 구조 설계, 구현, 테스트 코드와 화면을 통한 동작 확인까지 담당했다.

## 작업 배경

담당 시스템에서는 MySQL, Oracle, PostgreSQL, MSSQL, Cubrid 및 사내 DBMS 등 여러 데이터베이스의 오브젝트 정보를 동기화하는 기능을 제공하고 있었다.

동기화 대상에는 Table, Column, Index, Sequence, View, Synonym 등 다양한 오브젝트가 포함되었으며, DBMS마다 지원하는 오브젝트 종류와 메타데이터 조회 방식이 달랐다.

기존에는 단일 Processor 안에 DBMS별 동기화 메서드를 두어 이러한 차이를 처리하고 있었다.

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

이를 해결하기 위해 **Template Method와 Strategy를 적용하고, `DbmsFactory`의 Registry 기반 조회와 Object Composition으로 동기화 구조를 재설계했다.**

## 기존 구조의 문제점

### Problem 1. JDBC 자원 관리

기존에는 단일 Processor 안의 DBMS별 동기화 메서드에서 JDBC 자원을 직접 생성하고 해제했다.

문제를 분석할 때 MySQL의 `SHOW PROCESSLIST`에서 `Command`가 `Sleep`인 세션이 다수 보였고, 해당 세션의 `Time` 값이 길게 유지되는 것도 관찰했다. `Sleep`은 유휴 상태, `Time`은 현재 상태가 지속된 시간(초)을 뜻한다. 이 관찰만으로 자원 누수를 확정하지 않고, 아래와 같은 자원 해제 코드를 함께 점검했다. ([MySQL 공식 문서](https://dev.mysql.com/doc/refman/8.4/en/show-processlist.html))

```java
Connection conn = getConnection();
Statement stmt = conn.createStatement();
ResultSet rs = stmt.executeQuery(sql);

// DBMS별 메타데이터 조회 및 설정 로직

rs.close();
stmt.close();
conn.close();
```

- **원인** · JDBC 자원 생성과 해제가 DBMS별 구현에 반복됐다.
- **실패 경로** · SQL 실행이나 결과 처리 중 예외가 발생하면 뒤에 있는 `close()` 호출에 도달하지 못했다. 일부 구현에는 해제 호출도 빠져 있었다.
- **영향** · JDBC 자원이 누수될 수 있었고, 자원 관리 정책을 바꾸려면 여러 구현체를 함께 수정해야 했다.

### Problem 2. DBMS 분기

기존 구조에서는 **하나의 Processor 안에 DBMS별 메서드가 함께 있었다.** 오브젝트별 동기화 API는 DBMS 코드를 비교해 그 Processor의 해당 메서드를 호출했다.

```java
// 공개용 예시: 메서드명은 실제 코드와 무관한 가상 이름
if ("ORACLE".equals(dbmsCode)) {
    processor.syncOracleTable();
} else if ("MYSQL".equals(dbmsCode)) {
    processor.syncMySqlTable();
}
```

- **원인** · API가 DBMS 코드에 따라 동일 Processor의 메서드를 선택하는 분기를 직접 관리했다.
- **영향** · 신규 DBMS를 지원하려면 Processor에 메서드를 추가하고 관련 API의 분기도 수정해야 했다. Sequence나 Synonym처럼 일부 DBMS만 지원하는 오브젝트도 따로 고려해야 했다.

### Problem 3. 변경 시 영향 범위

기존 구조에서는 변경 유형에 따라 여러 영역을 함께 수정해야 했다.

| 변경 유형 | 기존 구조의 문제 |
|---|---|
| 신규 DBMS 추가 | 단일 Processor의 DBMS별 메서드 및 API 분기 조건 추가 |
| 신규 오브젝트 추가 | 오브젝트별 호출 로직과 지원 DBMS 구현 추가 |
| JDBC 실행 방식 변경 | 여러 DBMS의 중복 코드 수정 |
| 오브젝트 설정 로직 변경 | 해당 DBMS의 동기화 구현 수정 |

이러한 문제를 해결하기 위해 공통 실행 흐름과 DBMS별 구현을 분리하고, 각 기능을 독립적으로 확장할 수 있는 구조가 필요했다.

## 개선 방향

기존 구조를 분석한 후 적용한 패턴과 설계 원칙은 다음과 같다.

| 구분 | 적용 방식 |
|---|---|
| **Template Method 패턴** | 공통 JDBC 실행 순서를 추상 클래스에 정의하고, DBMS별 SQL 생성과 메타데이터 설정은 하위 구현체로 분리했다. `Statement`와 `ResultSet`은 `try-with-resources`로 해제한다. |
| **Strategy 패턴** | DBMS마다 다른 동기화 구현체를 공통 인터페이스로 선택하고 실행한다. |
| **Factory 역할과 Registry 방식** | DBMS별 Synchronizer를 Spring Bean으로 등록해 DBMS 타입을 키로 Map에 보관하고, `DbmsFactory`가 요청 타입으로 구현체를 찾아 기존 `if-else` 분기를 제거한다. |
| **Object Composition** | 각 DBMS Synchronizer가 지원하는 오브젝트 동기화 Bean만 조합해 필요한 기능을 제공한다. |

핵심은 **공통 실행 흐름은 재사용하고, DBMS 및 오브젝트별 차이는 독립적인 구현체로 분리하는 것**이었다.

## 개선 구조

### DBMS와 오브젝트별 동기화 책임 분리

기존의 DBMS별 동기화 로직을 다음과 같이 역할별로 분리했다.

<figure class="sync-diagram" aria-labelledby="sync-diagram-title">
  <figcaption id="sync-diagram-title"><span>ARCHITECTURE</span><strong>DBMS 선택과 오브젝트 동기화 책임 분리</strong></figcaption>
  <div class="sync-diagram-flow" aria-label="요청에서 DBMS 동기화 구현체 선택까지">
    <div class="sync-diagram-node"><small>REQUEST</small><strong>Controller / Service</strong><span>동기화 요청</span></div>
    <span class="sync-diagram-flow-arrow" aria-hidden="true">→</span>
    <div class="sync-diagram-node is-factory"><small>FACTORY / REGISTRY</small><strong>DbmsFactory</strong><span>get(DbmsType) → DbmsSynchronizer</span><span>DBMS 타입을 키로 등록한 Spring Bean 조회</span></div>
    <span class="sync-diagram-flow-arrow" aria-hidden="true">→</span>
    <div class="sync-diagram-node"><small>CONTRACT</small><strong>DbmsSynchronizer</strong><span>sync(ObjectType)</span></div>
  </div>
  <div class="sync-diagram-down"><span aria-hidden="true">↓</span><small>DBMS별 클래스가 DbmsSynchronizer를 구현하고, 오브젝트별 Spring Bean을 생성자로 주입받음</small></div>
  <div class="sync-diagram-dbms" aria-label="DBMS별 오브젝트 동기화 구현 예시">
    <div class="sync-diagram-dbms-card"><small>ORACLE</small><strong>OracleSynchronizer</strong><span class="sync-diagram-map">ObjectType으로 구현체 선택</span><ul><li><span>TABLE</span><strong>OracleTableSynchronizer</strong></li><li><span>INDEX</span><strong>OracleIndexSynchronizer</strong></li><li><span>SEQUENCE</span><strong>OracleSequenceSynchronizer</strong></li></ul></div>
    <div class="sync-diagram-dbms-card"><small>MYSQL</small><strong>MySqlSynchronizer</strong><span class="sync-diagram-map">ObjectType으로 구현체 선택</span><ul><li><span>TABLE</span><strong>MySqlTableSynchronizer</strong></li><li><span>COLUMN</span><strong>MySqlColumnSynchronizer</strong></li><li><span>INDEX</span><strong>MySqlIndexSynchronizer</strong></li></ul></div>
    <div class="sync-diagram-dbms-card"><small>POSTGRESQL</small><strong>PostgreSqlSynchronizer</strong><span class="sync-diagram-map">ObjectType으로 구현체 선택</span><ul><li><span>TABLE</span><strong>PostgreSqlTableSynchronizer</strong></li><li><span>SEQUENCE</span><strong>PostgreSqlSequenceSynchronizer</strong></li></ul></div>
  </div>
  <div class="sync-diagram-down"><span aria-hidden="true">↓</span><small>오브젝트 구현체가 AbstractObjectSynchronizer 상속</small></div>
  <div class="sync-diagram-template">
    <div><small>SHARED TEMPLATE METHOD</small><strong>AbstractObjectSynchronizer</strong><span>ObjectSynchronizer 구현 · sync()</span></div>
    <ol aria-label="공통 JDBC 실행 순서"><li>getQuery()로 조회 SQL 생성</li><li>Statement로 SQL 실행</li><li>syncObject(ResultSet) 호출</li><li>JDBC 자원 해제</li></ol>
  </div>
  <p class="sync-diagram-note">각 DBMS는 지원하는 오브젝트 동기화 구현체만 조합한다. OracleTableSynchronizer와 MySqlColumnSynchronizer 같은 구체 클래스는 AbstractObjectSynchronizer를 상속해 공통 실행 흐름을 재사용한다.</p>
</figure>

#### 실행 예시 · Oracle TABLE 동기화

1. **DBMS 선택** · 호출부가 `dbmsFactory.get(DbmsType.ORACLE)`로 `OracleSynchronizer`를 받는다.
2. **오브젝트 선택** · `sync(ObjectType.TABLE)`을 호출하면 `OracleSynchronizer`가 Map에서 `OracleTableSynchronizer`를 찾아 작업을 위임한다.
3. **메타데이터 처리** · 선택된 구현체의 공통 `sync()`가 동기화 대상 DB에 연결해 Oracle 전용 SQL을 실행하고, `syncObject(ResultSet)`이 조회 결과를 테이블 메타데이터로 변환한다.
4. **자원 해제** · 공통 실행 코드가 동기화 대상 DB의 `ResultSet`, `Statement`, `Connection`을 `try-with-resources`로 닫는다.

동기화 대상 DB를 조회하는 `Connection`은 변경사항을 관리하는 Spring 트랜잭션의 연결과 별개다. 동기화가 실패하면 예외를 런타임 예외로 변환해 전파했고, Spring 트랜잭션 관리가 변경사항을 롤백했다. 화면에는 동기화 실패 알림을 표시했다.

아래 탭에서 Template Method와 Strategy, Registry 기반 Factory 역할을 각각 설명한다. 오브젝트 조합은 그다음 절에서 다룬다.

### Pattern 1. Template Method

DBMS별로 반복되는 JDBC 실행 흐름을 `AbstractObjectSynchronizer` 추상 클래스로 통합했다.

공통 실행 흐름은 상위 클래스에서 정의하고, DBMS마다 달라지는 SQL 생성 및 결과 처리 로직은 추상 메서드로 분리했다.

아래는 공통 실행 흐름을 단순화한 공개용 예시다. `getConnection()`은 동기화 대상 DB 연결 획득 지점을 나타내는 예시용 추상 훅이다.

```java
public abstract class AbstractObjectSynchronizer implements ObjectSynchronizer {

    @Override
    public void sync() throws SQLException {
        String sql = getQuery();

        try (Connection connection = getConnection();
             Statement stmt = connection.createStatement();
             ResultSet rs = stmt.executeQuery(sql)) {
            syncObject(rs);
        }
    }

    protected abstract Connection getConnection() throws SQLException;

    protected abstract String getQuery();

    protected abstract void syncObject(ResultSet rs) throws SQLException;
}
```

Oracle TABLE과 MySQL COLUMN이라는 서로 다른 DBMS·오브젝트 조합으로 `getConnection()`, `getQuery()`, `syncObject(ResultSet)`의 구현을 보여준다. 아래 두 클래스는 **공개용 일반화 예시**이며, `@Qualifier`의 Bean 이름과 `DataSource` 구성은 실제 내부 설정이 아닌 설명을 위한 가정이다.

```java
@Component
public class OracleTableSynchronizer extends AbstractObjectSynchronizer {
    private final DataSource targetDataSource;

    public OracleTableSynchronizer(@Qualifier("exampleOracleDataSource") DataSource targetDataSource) {
        this.targetDataSource = targetDataSource;
    }

    @Override
    protected Connection getConnection() throws SQLException {
        return targetDataSource.getConnection();
    }

    @Override
    protected String getQuery() {
        return "SELECT OWNER, TABLE_NAME FROM ALL_TABLES";
    }

    @Override
    protected void syncObject(ResultSet rs) throws SQLException {
        while (rs.next()) {
            String owner = rs.getString("OWNER");
            String tableName = rs.getString("TABLE_NAME");
            // 조회 값을 내부 메타데이터에 반영하는 실제 로직은 생략
        }
    }
}
```

```java
@Component
public class MySqlColumnSynchronizer extends AbstractObjectSynchronizer {
    private final DataSource targetDataSource;

    public MySqlColumnSynchronizer(@Qualifier("exampleMySqlDataSource") DataSource targetDataSource) {
        this.targetDataSource = targetDataSource;
    }

    @Override
    protected Connection getConnection() throws SQLException {
        return targetDataSource.getConnection();
    }

    @Override
    protected String getQuery() {
        return "SELECT TABLE_SCHEMA, TABLE_NAME, COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS";
    }

    @Override
    protected void syncObject(ResultSet rs) throws SQLException {
        while (rs.next()) {
            String schema = rs.getString("TABLE_SCHEMA");
            String tableName = rs.getString("TABLE_NAME");
            String columnName = rs.getString("COLUMN_NAME");
            // 조회 값을 내부 메타데이터에 반영하는 실제 로직은 생략
        }
    }
}
```

예시 SQL에는 공개 카탈로그의 컬럼만 사용했다. 실제 동기화 범위와 조회 조건은 이 예시에서 다루지 않는다. ([Oracle `ALL_TABLES`](https://docs.oracle.com/en/database/oracle/oracle-database/26/refrn/ALL_TABLES.html), [MySQL `INFORMATION_SCHEMA.COLUMNS`](https://dev.mysql.com/doc/refman/8.4/en/information-schema-columns-table.html))

추상 클래스의 `try-with-resources`는 `ResultSet`, `Statement`, 동기화 대상 DB의 `Connection`을 해제한다. 이 연결의 종료와 Spring 트랜잭션의 롤백은 서로 다른 연결에 관한 처리다.

`OracleTableSynchronizer`와 `MySqlColumnSynchronizer` 같은 오브젝트별 구체 클래스는 `AbstractObjectSynchronizer`를 상속한다. 공통 `sync()`를 재사용하고, 각 클래스에서 DBMS·오브젝트에 맞는 SQL 생성과 결과 처리를 구현한다.

이 구조에서 `sync()`는 실행 흐름을 정의하는 Template Method 역할을 한다.

실행 순서는 다음과 같다.

1. `getQuery()`를 호출하여 DBMS별 SQL 생성
2. 동기화 대상 DB에 연결하고 `Statement`로 SQL 실행
3. `syncObject()`를 호출하여 DBMS별 결과 처리
4. 공통 실행 코드의 `try-with-resources`로 `ResultSet`, `Statement`, `Connection` 해제

### Pattern 2. Strategy

DBMS마다 같은 TABLE 동기화 요청에도 조회 SQL과 메타데이터 처리 방식이 다르다. `OracleSynchronizer`, `MySqlSynchronizer` 등의 DBMS별 구현체가 공통 `DbmsSynchronizer` 계약을 따르도록 하고, 요청한 DBMS 타입에 맞는 구현체를 선택해 실행했다.

```java
DbmsSynchronizer synchronizer = dbmsFactory.get(dbmsType);
synchronizer.sync(ObjectType.TABLE);
```

첫 번째 선택은 `DbmsType`으로 `OracleSynchronizer` 같은 DBMS 전략을 찾는 것이다. 선택된 DBMS 구현체 안에서는 두 번째로 `ObjectType`에 해당하는 오브젝트 구현체를 Map에서 찾아 위임한다. Oracle 요청에는 `OracleTableSynchronizer`, MySQL 요청에는 `MySqlTableSynchronizer`가 TABLE 처리를 맡는다. 이 구현체들은 공통 JDBC 흐름을 사용하면서 SQL 생성과 메타데이터 처리는 각각 구현한다.

즉 **Strategy는 DBMS별 구현체를 선택·실행하는 경계**, Template Method는 **선택된 오브젝트 구현체 내부의 JDBC 실행 순서**를 담당한다.

### Pattern 3. Factory 역할과 Registry

기존에는 Problem 2처럼 동기화 API가 DBMS 코드를 비교해 단일 Processor의 DBMS별 메서드를 선택했다.

DBMS별 Synchronizer를 Spring Bean으로 등록하고, `DbmsFactory`가 타입에 맞는 구현체를 제공하도록 변경했다. 이 Factory의 실제 역할은 **이미 등록된 Bean의 선택과 제공**이다.

#### Registry · Spring Bean을 Map으로 관리

`DbmsFactory`는 Spring이 생성한 DBMS별 Synchronizer Bean을 **DBMS 타입을 키로 하는 Map에 등록**한다. 요청이 오면 전달받은 타입으로 Map을 조회해 맞는 Bean을 반환한다. 이 등록·조회 과정이 여기서 말하는 Registry 기반 선택이며, 호출부의 반복적인 `if-else` 분기를 없앴다. 아래는 조회 메서드만 발췌한 일반화 예시다.

```java
public DbmsSynchronizer get(DbmsType dbmsType) {
    DbmsSynchronizer synchronizer = synchronizers.get(dbmsType);

    if (synchronizer == null) {
        throw new IllegalArgumentException("Unsupported DBMS: " + dbmsType);
    }

    return synchronizer;
}
```

Spring에서 등록한 구현체를 `DbmsType`으로 매핑하는 등록 부분은 예시에서 생략했다. DBMS 선택을 위한 조건문은 Factory의 조회 로직으로 대체했다.

호출부는 Strategy 탭의 예시처럼 `dbmsFactory.get(dbmsType)`으로 구현체를 받아 실행한다.

또한 사용처는 `OracleSynchronizer`, `MySqlSynchronizer`와 같은 구체 클래스를 직접 참조하지 않고 `DbmsSynchronizer` 인터페이스에 의존하도록 변경했다.

이를 통해 신규 DBMS를 추가할 때 기존 동기화 API의 조건문을 수정할 필요가 없어졌으며, 해당 DBMS의 구현체를 추가하고 Factory에 등록되도록 구성하면 된다.

## Object Composition · 지원 오브젝트 구현체 조합

DBMS마다 지원하는 오브젝트가 다르다는 점을 고려하여 오브젝트별 동기화 구현체를 분리하고, 각 구체 구현체를 Spring Bean으로 등록했다.

각 DBMS Synchronizer는 자신이 지원하는 오브젝트 동기화 Bean을 생성자로 주입받아 `ObjectType`을 키로 하는 Map에 담았다.

```java
public interface DbmsSynchronizer {
    void sync(ObjectType objectType) throws SQLException;
}
```

Oracle의 경우 다음과 같이 구성할 수 있다.

```java
@Component
public class OracleSynchronizer implements DbmsSynchronizer {

    private final Map<ObjectType, ObjectSynchronizer> synchronizers;

    public OracleSynchronizer(OracleTableSynchronizer tableSynchronizer,
                              OracleIndexSynchronizer indexSynchronizer,
                              OracleSequenceSynchronizer sequenceSynchronizer) {
        synchronizers = new EnumMap<>(ObjectType.class);
        synchronizers.put(ObjectType.TABLE, tableSynchronizer);
        synchronizers.put(ObjectType.INDEX, indexSynchronizer);
        synchronizers.put(ObjectType.SEQUENCE, sequenceSynchronizer);
    }

    @Override
    public void sync(ObjectType objectType) throws SQLException {
        ObjectSynchronizer synchronizer = synchronizers.get(objectType);

        if (synchronizer == null) {
            throw new IllegalArgumentException("Unsupported object type: " + objectType);
        }

        synchronizer.sync();
    }
}
```

*위 코드는 생성자 주입과 지원 오브젝트의 위임 경로를 보여주는 일반화 예시다. `OracleTableSynchronizer`, `OracleIndexSynchronizer`, `OracleSequenceSynchronizer`는 각각 Spring Bean으로 등록된 구현체다. 이 예시에서 미지원 타입은 `ObjectSynchronizer.sync()` 호출 전에 예외를 던지므로 동기화 대상 DB의 `Connection`도 획득하지 않는다. 실제 예외 변환과 Spring 트랜잭션 처리는 생략했다.*

이 구조에서는 `OracleSynchronizer`가 모든 오브젝트 동기화 로직을 직접 구현하지 않는다.

대신 Table, Index, Sequence 등 각 오브젝트에 해당하는 Synchronizer를 보유하고, 요청한 오브젝트 타입에 따라 적절한 구현체에 작업을 위임한다.

이러한 방식에는 **필요한 기능의 구현체를 보유하고 조합하는 Object Composition 원칙**을 적용했다.

이 시스템의 동기화 기능에서는 DBMS마다 지원하는 오브젝트가 달랐다.

| DBMS | 공통 지원 | 추가 지원 오브젝트 |
|---|---|---|
| MySQL | Table, Column, Index | View |
| Oracle | Table, Column, Index | Serial/Sequence, View, SP, Function, Trigger, Synonym |
| PostgreSQL | Table, Column, Index | Serial, SP, Trigger |
| MSSQL | Table, Column, Index | Trigger, Synonym |
| 사내 DBMS | Table, Column, Index | View |
| Cubrid | Table, Column, Index | Serial |

각 DBMS Synchronizer는 실제 지원하는 오브젝트 동기화 구현체만 보유했다. 지원하지 않는 오브젝트의 구현체를 구성할 필요가 없어졌다.

또한 화면에서는 DBMS별 지원 오브젝트를 기준으로 선택할 수 없는 항목을 비활성화하여 사용자가 지원하지 않는 동기화 기능을 요청하지 않도록 처리했다.

## 개선 결과

### JDBC 실행 코드와 자원 관리

DBMS별로 반복되던 JDBC 실행 흐름을 `AbstractObjectSynchronizer`로 모았다. 공통 실행 코드에서 동기화 대상 DB의 `Statement`, `ResultSet`, `Connection`을 `try-with-resources`로 해제했다. DBMS별 구현체는 SQL 생성과 메타데이터 처리에 집중할 수 있게 되었다.

### DBMS 선택과 변경 범위

동기화 API의 DBMS별 조건문은 `DbmsFactory`의 타입별 조회로 대체했다. 호출부는 `DbmsSynchronizer` 계약을 사용하고, 각 DBMS 구현체는 지원하는 오브젝트 구현체만 조합한다.

| 변경 유형 | 수정할 위치 |
|---|---|
| 신규 DBMS 추가 | DBMS별 Synchronizer와 지원 오브젝트 구현체 등록 |
| 신규 오브젝트 추가 | 해당 오브젝트를 지원하는 DBMS의 구현체와 구성 |
| JDBC 실행 방식 변경 | 공통 추상 클래스 |
| 메타데이터 처리 변경 | 해당 DBMS·오브젝트 구현체 |

이처럼 변경 성격에 따라 수정할 코드의 위치를 분리했다.

### 동작 확인

테스트 코드와 실제 화면에서 동기화 기능이 정상 동작하는 것을 확인했다.

## 정리

공통 JDBC 실행 순서와 DBMS별 처리를 분리하고, Registry 기반 선택과 지원 오브젝트 구현체 조합으로 동기화 구조를 정리했다. 동기화 대상 DB의 `Statement`, `ResultSet`, `Connection` 해제 경로를 공통화하고, DBMS나 오브젝트를 추가할 때 수정할 위치를 분명히 했다.
