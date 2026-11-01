---
title: "Spring Boot 2.1.2 → 3.1.0 마이그레이션"
company: "N Tech Service"
role: "마이그레이션 전반의 호환성 분석·적용·검증 담당"
category: "Framework Migration"
summary: "Java 8·Spring Boot 2.1.2에서 Java 17·Spring Boot 3.1.0으로 전환하며 jOOQ, JDBC와 사내 ACL 호환성 문제를 해결하고 단계적으로 운영 적용"
skills:
  - Java 17
  - Spring Boot
  - Jakarta EE
  - jOOQ
  - MySQL
  - JDBC
  - Nginx
featured: true
order: 7
draft: false
---

Java 8·Spring Boot 2.1.2 기반 시스템을 Java 17·Spring Boot 3.1.0으로 한 번에 마이그레이션했다. 버전 변경 뒤 애플리케이션 코드와 라이브러리뿐 아니라 DB 실행과 접근 제어에서도 호환성 문제를 확인했다. 각 문제의 원인을 분석해 해결하고, 기존 기능 검증부터 일부 서버 선배포와 전체 적용까지 진행했다.

## 작업 배경과 변경 범위

사내 Repository에서 제공하는 JDK의 LTS 버전이 Java 17이어서, 기존 Java 8 환경을 Java 17로 전환하기로 했다. 이에 맞춰 Spring Boot도 2.1.2에서 3.1.0으로 변경했다. 중간 버전을 단계별로 적용하지 않고 목표 버전으로 한 번에 옮겼으며, Spring Framework 등 개별 버전은 직접 지정하지 않고 Spring Boot Dependency Management를 따랐다.

노후화된 Java, Spring Boot 및 관련 라이브러리를 최신 환경으로 옮겨 잠재적인 보안 문제를 줄이려는 목적도 있었다.

| 영역 | 변경 전 | 변경 후 |
| --- | --- | --- |
| Java | 8 | 17 |
| Spring Boot | 2.1.2 | 3.1.0 |
| jOOQ | 3.11.9 | 3.18.4 |
| MySQL Connector/J | `mysql:mysql-connector-java:5.1.47` | `com.mysql:mysql-connector-j:8.0.33` |
| API 문서화 | Springfox Swagger 2 / UI 2.6.1 | `springdoc-openapi-starter-webmvc-ui:2.1.0` |
| Java EE API | `javax.*` | `jakarta.*` |

이 변경 범위 안에서 컴파일 오류, DB 실행 오류, 사내 라이브러리 호환성 문제를 차례로 해결했다.

## 애플리케이션 코드의 호환성 정리

Spring Boot 3 및 Spring Framework 6의 Jakarta EE 전환에 맞춰 애플리케이션의 `javax.*` 기반 코드를 `jakarta.*`로 변경했다. `javax.annotation`, `javax.validation`, `javax.persistence`, `javax.servlet` 사용 부분이 대상이었다. 이 과정에서 기존 코드가 의존하던 Servlet 및 관련 API를 새 환경에 맞춰 정리했다.

Spring API를 사용하는 코드에서는 **새 API에 맞추되 기존 역할을 유지하는지** 확인했다.

- 요청 처리에 사용하던 `HandlerInterceptorAdapter`를 `HandlerInterceptor` 구현으로 변경했다. 기존 Adapter는 필요한 콜백을 상속해 재정의하는 클래스였고, 인터페이스에는 콜백의 기본 구현이 있어 필요한 메서드만 직접 구현할 수 있다. 요청 전·후·완료 시점의 처리라는 역할은 그대로 두고, 구현 방식과 Servlet 타입을 새 환경에 맞췄다.
- MongoDB 접근 코드의 `MongoDbFactory`를 `MongoDatabaseFactory`로 변경했다. 둘 다 사용할 데이터베이스를 제공하는 Factory이며, API에서 `getDb()`에 대응하는 메서드는 `getMongoDatabase()`다. 데이터 저장 방식을 바꾸는 작업이 아니라 기존 접근 코드를 새 Spring Data API에 맞추는 작업이었다.
- 기존 `ErrorController` 구현의 `getErrorPath()` 관련 코드도 변경된 API에 맞춰 수정했다.

이후 단위·통합 테스트와 API·프론트엔드 기능 확인을 통해 요청 처리와 데이터 접근을 포함한 기존 기능의 동작을 검증했다.

API 문서화에는 `io.springfox:springfox-swagger2:2.6.1`과 `io.springfox:springfox-swagger-ui:2.6.1`을 사용하고 있었다. Spring Boot 3으로 옮기기 전에 Springfox의 호환성을 검토하고, `org.springdoc:springdoc-openapi-starter-webmvc-ui:2.1.0`으로 선제적으로 전환했다. 실제 장애가 발생한 뒤 교체한 것은 아니다.

## jOOQ 쿼리와 API 사용 목적 확인

기본 API 변경을 마친 뒤에는 jOOQ 코드에서 컴파일과 DB 실행 문제가 드러났다. 코드를 기계적으로 치환하기보다 표현식의 구성과 조회 결과를 사용하는 목적을 각각 확인했다.

### Alias와 Field 표현식 문제

기존 jOOQ DSL로 생성한 쿼리를 DB에서 실행할 때 Alias·타입 관련 문제가 발생했고, 오류에는 `Incompatible Types`가 포함되어 있었다. 문제가 된 코드의 표현식 구성은 개념적으로 다음과 같았다.

~~~java
select(...)
    // ...
    .asField("new")
    .cast(String.class)
~~~

기존에는 Alias를 적용한 표현식에 Cast를 수행했다. 이를 `field(select(...))`로 Field 표현식을 명확하게 만든 뒤 Cast하고, 마지막에 Alias를 적용하도록 변경했다.

~~~java
field(
    select(...)
        // ...
)
.cast(String.class)
.as("new")
~~~

변경 후 해당 쿼리가 정상 동작하는 것을 확인했다. 이 문제는 DB 실행 과정에서 드러났지만 정확한 생성 SQL은 확인되지 않아, jOOQ 내부의 어떤 변경이나 Java 17의 타입 추론이 직접 원인인지는 단정하지 않는다.

### `fetchCount()`에서 `fetchExists()`로 변경

기존 `fetchCount()` 사용 코드 중에는 마이그레이션 후 컴파일되지 않는 부분이 있었다. 해당 코드는 실제 건수를 반환하거나 활용하지 않고 `fetchCount() > 0`으로 데이터가 하나라도 있는지만 판단했다.

~~~java
return select(...)
    // ...
    .fetchCount() > 0;
~~~

필요한 결과가 건수가 아닌 존재 여부라는 점을 확인한 뒤 `fetchExists()` 기반으로 변경했다.

~~~java
return fetchExists(
    selectOne()
        // ...
);
~~~

`fetchCount()`와 `fetchExists()`는 같은 값을 반환하는 API가 아니다. 기존 코드가 건수로 표현하던 조건의 의미를 확인하고, 존재 여부 조회에 맞는 방식으로 옮긴 것이다.

## GROUP_CONCAT 쿼리의 SQL Syntax Error 추적

### 드라이버 변경과 함께 확인한 연결 설정

MySQL Connector/J도 5.1.47에서 8.0.33으로 변경했다. Maven 좌표는 `mysql:mysql-connector-java`에서 `com.mysql:mysql-connector-j`로, JDBC Driver 클래스는 `com.mysql.jdbc.Driver`에서 `com.mysql.cj.jdbc.Driver`로 바뀌었다. 연결 속성에도 버전 간 차이가 있어, 드라이버 교체 이후에는 기존 JDBC URL이 새 실행 환경에서 필요한 동작을 허용하는지 확인해야 했다.

다만 이번 `GROUP_CONCAT` 오류를 드라이버가 새로 Multi Statement를 막았기 때문이라고 볼 수는 없었다. `allowMultiQueries`의 기본값은 이전 Connector/J에서도 `false`였다. 원인을 찾으려면 **드라이버와 함께 변경된 jOOQ가 실제로 어떤 SQL을 실행하는지** 봐야 했다.

### 애플리케이션 SQL에 없던 `SET` 문 추적

jOOQ 3.11.9 → 3.18.4와 Connector/J 5.1.47 → 8.0.33을 적용한 뒤, `GROUP_CONCAT` 쿼리에서 SQL Syntax Error가 발생했다. 오류에는 `near 'set @@group_concat_max_len = 4294967295;`라는 문구가 있었다. 그런데 애플리케이션에서 작성한 조회 코드에는 `SET` 문이 없었다.

오류에 나온 `group_concat_max_len`을 따라가며 jOOQ의 버전별 처리 방식을 확인했다. jOOQ 3.15부터는 MySQL의 `GROUP_CONCAT` 결과가 길이 제한으로 잘리는 것을 막기 위해 Session 설정을 자동 조정한다. 기존 3.11.9에는 없던 동작이 3.18.4에는 포함되어, SELECT 앞뒤에 설정값을 보관·변경·복원하는 Statement가 붙었다.

~~~text
개념적인 실행 흐름

jOOQ 3.11.9
GROUP_CONCAT 조회 → SELECT 실행

jOOQ 3.18.4
GROUP_CONCAT 조회
  → 기존 group_concat_max_len 보관
  → Session 제한값 변경
  → SELECT 실행
  → 기존 설정 복원
~~~

애플리케이션에서는 하나의 조회를 요청했지만, 새 jOOQ 버전이 실행한 SQL에는 여러 Statement가 포함됐다. JDBC 연결은 `allowMultiQueries=false`여서 이 실행을 허용하지 않았다. **오류의 원인은 jOOQ 3.15부터 추가된 Session 설정 동작과 기존 JDBC 연결 옵션의 충돌**이었다.

JDBC URL에 `allowMultiQueries=true`를 적용한 뒤 해당 `GROUP_CONCAT` 쿼리가 정상 동작하는 것을 확인했다. 드라이버 버전도 함께 변경했지만, 이 사례에서 확인한 문제는 `GROUP_CONCAT` 함수 자체의 변경이나 Connector/J 기본값 변경이 아니었다.

## 사내 ACL 라이브러리의 적용 위치 변경

기존 시스템은 등록된 사용자만 API에 접근할 수 있도록 사내 ACL 라이브러리를 Maven Dependency로 포함했다. 애플리케이션에서 `AclContext`를 Bean으로 등록하면 라이브러리가 설정을 읽고 WAS 안의 Filter로 동작했다.

~~~java
@Bean(initMethod = "init", destroyMethod = "destroy")
public AclContext aclContext(
    @Value("${acl.config}") String aclConfigFile
) {
    System.setProperty("acl.config", aclConfigFile);
    return new AclContext();
}
~~~

~~~text
기존 요청 흐름
Client → Nginx → WAS → ACL Filter → Spring MVC / Controller
~~~

Spring Boot 3 전환 후에는 이 방식을 그대로 사용할 수 없었다. 사내 ACL 라이브러리 자체가 Spring Boot 2.x 기반이며 `javax.servlet.*`에 의존하는 반면, 새 애플리케이션은 `jakarta.servlet.*` 기반이기 때문이다. 애플리케이션 코드의 import를 변경하는 것만으로는 외부 라이브러리의 Servlet API 의존성을 해결할 수 없었다.

기존 ACL 검증을 유지할 다른 적용 방법을 확인했다. 사내 ACL 시스템은 WAS Filter 외에도 동일한 ACL 기능을 Nginx Dynamic Filter로 지원했다. 이 방식은 애플리케이션의 Spring Boot 버전에 직접 종속되지 않아, ACL 적용 위치를 WAS에서 Nginx 계층으로 옮겼다.

~~~text
변경 전
Client → Nginx → WAS → ACL Filter → Spring MVC / Controller

변경 후
Client → Nginx → ACL Dynamic Filter → WAS → Spring MVC / Controller
~~~

ACL 정책이나 등록 사용자에 대한 접근 제어 동작은 유지했다. 목적은 새로운 인증 체계를 도입하는 것이 아니라, 기존 ACL 기능을 유지하면서 Spring Boot 3과 사내 라이브러리의 호환성 문제를 해결하는 것이었다.

## 기능 검증과 단계적 운영 적용

컴파일과 애플리케이션 실행만으로 마이그레이션을 완료했다고 판단하지 않았다. 기존 단위·통합 테스트가 모두 통과하는지 확인한 뒤, Postman으로 API를 직접 호출했다. 프론트엔드에서도 주요 기능을 실행해 기존 기능의 동작을 확인했다.

운영 환경에서는 일부 서버에 먼저 배포했다. 기존 모니터링 도구의 로그와 API 응답·동작을 확인하고 문제가 없음을 확인한 뒤 나머지 서버에도 적용했다.

~~~text
컴파일·실행 확인
→ 기존 단위·통합 테스트 통과
→ Postman API 호출
→ 프론트엔드 주요 기능 확인
→ 일부 서버 선배포
→ 로그·API 응답 모니터링
→ 나머지 서버 적용
~~~

## 결과와 회고

Java 8·Spring Boot 2.1.2 기반 시스템을 Java 17·Spring Boot 3.1.0으로 전환했다. Jakarta EE와 Spring API, API 문서화, jOOQ DSL, MySQL Connector/J, 사내 ACL에 걸친 호환성 문제를 해결하고 전체 서버에 적용했다. 노후화된 라이브러리 사용에 따른 잠재적인 보안 문제를 줄이는 데도 기여했다.

이번 작업에서는 컴파일 오류 해결 이후의 확인이 특히 중요했다. DB 실행 과정의 Alias·타입 오류, 애플리케이션 SQL에 보이지 않던 jOOQ의 Multi Statement 처리, WAS 내부 ACL 라이브러리의 `javax.servlet` 의존성은 각각 다른 위치에서 드러났다. 기존 코드와 실행 경로를 따라 원인을 확인하고, 기능 검증과 일부 서버 선배포를 거쳐 마이그레이션을 마쳤다.
