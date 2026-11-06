# 구현 계약

## 1. 모듈 경계

```text
apps/web                 고객·관리자 화면, HTTP API, 세션·요청 검증
apps/worker              작업 실행, 만료, 발송, 결제 대사
packages/domain          정책 평가, 예약 명령, 상태 전이
packages/db              Prisma schema, SQL migration, 트랜잭션·쿼리
packages/providers       SMS·결제·전화 Adapter
packages/shared          타입, 오류 코드, 시간·금액 유틸리티
docs/adr                 기술·정책 결정 근거
docs/runbooks            배포·장애·복구·운영 절차
```

도메인 로직을 화면 컴포넌트나 특정 제공업체 SDK에 넣지 않는다. 모든 채널은 같은 명령을 호출한다. 초기에는 여러 서비스로 분산 배포하지 않는다.

## 2. 데이터 모델

ID는 UUID를 사용하고 주요 변경 가능 엔티티에 `version`, `created_at`, `updated_at`을 둔다. 모든 매장 데이터는 매장 소속을 검증하며 교차 매장 FK 연결을 DB 제약 또는 명시적 검증으로 방지한다.

| 모델 | 필수 필드·제약 |
|---|---|
| restaurants | timezone, currency, 기본 언어, 활성 정책 포인터 |
| users / restaurant_members | 인증 주체, 매장, 역할, 계정 활성 상태 |
| dining_tables | restaurant_id, name, 기본·최대 좌석, 구역, 활성 기간; 매장 내 이름 유일 |
| table_combinations / members | 최대 인원, 활성 기간, 실제 테이블 FK; 같은 테이블 중복 포함 금지 |
| business_hours | 요일, 시작 현지시각, 종료 현지시각, 종료일 offset |
| special_business_dates | 영업일, 휴무 또는 대체 구간; 날짜별 기준 중복 금지 |
| reservation_blocks | 기간, 사유, 전체/테이블 범위, 작성자 |
| policy_versions | 매장, 버전 번호, DRAFT/PUBLISHED/RETIRED, 방문일 적용 범위, 게시자 |
| policy_rules | 종류, 조건, 우선순위, 검증된 타입별 값; 버전 소속 |
| reservations | 매장, 예약번호, 출처, 고객 연락처, 방문·종료시각, 영업일, 인원, 상태, expires_at, version |
| reservation_policy_snapshots | 예약, 변경 revision, 정책 버전, 평가 입력·결과, 이용시간, 정리시간, 최소소비·예약금, 취소·환불 조건, 통화, 동의 문구 버전 |
| reservation_allocations | 예약 또는 좌석 제안 소유자, 실제 table_id, occupied_period, released_at; 소유자는 정확히 하나 |
| table_occupancies | 실제 착석·퇴석시각, 예약, table_id; 현재 착석 중인 테이블 중복 금지 |
| reservation_changes | 원예약, 제안 조건·가격, 새 점유, 기한, 추가 결제 참조, 상태 |
| reservation_events | 예약, 이벤트 종류, 행위자, 사유, 변경 revision, 발생시각 |
| payments | 예약/변경 참조, 금액·통화, provider, provider_payment_id, 상태, idempotency_key |
| refunds | payment_id, 금액, 이유, 상태, provider_refund_id, 요청 키 |
| waitlist_entries | 인원, 희망 구간, 연락처, 접수시각, 상태 |
| waitlist_offers | 대기 항목, 실제 점유, 발송 상태, 응답 기한, 절대 만료시각, 수락 상태 |
| provider_connections | 제공업체 종류, 비밀정보 참조, 제한된 비밀 아닌 설정, 검증 상태 |
| notification_deliveries | 예약/제안, 템플릿 버전, 언어, 발송 상태, provider ID, 재시도 수 |
| outbox_events / jobs | 이벤트 ID, 종류, 최소 payload, 실행 가능시각, lease 기한, 시도 수, 결과 |
| webhook_receipts | provider, event_id, 처리 상태; provider+event_id 유일 |
| idempotency_requests | 매장+행위자/세션+작업+키 유일, 요청 hash, 처리 결과·만료 |
| audit_logs | 행위자, 대상, 사유, 비밀값을 제거한 변경 내용, 시각 |

정책 규칙은 예약·최소소비·예약금·취소·대기별 테이블로 분리하거나 타입별 스키마 검증을 둔다. 일반적인 무제한 JSON 설정 저장소로 대체하지 않는다. 예약 당시의 불변 결과와 제공업체별 비밀 아닌 옵션에는 JSON을 사용할 수 있다.

금액은 최소 통화 단위 정수로 저장하며, 제공업체 Adapter가 업체 API의 단위로 변환한다. 실수 계산과 통화 단위 추측을 금지한다. 환불 누계는 성공 결제액을 초과하지 못하도록 결제 행 잠금 하에서 검증한다.

## 3. 시간 계약

- 실제 시각은 UTC `timestamptz`, 화면과 영업 규칙 계산은 매장 시간대 기준이다.
- 영업일은 매장 현지 날짜다. 예: 금요일 22:00~익일 02:00은 금요일 영업 구간이다.
- 모든 점유는 `[시작, 종료)` 반개구간을 사용한다.
- 예약 시작 간격은 각 영업구간 시작점을 기준으로 계산한다.
- 마지막 입장 시각과 이용 종료 가능 시각을 분리한다. 기본은 이용 종료가 영업구간 내에 들어와야 하며, 정리시간은 별도 설정으로 영업 종료 이후 허용 여부를 결정한다.
- 휴무·공휴일은 버전이 확인된 날짜 목록 또는 운영자 등록으로 관리한다. 토·일과 공휴일을 동일시하지 않는다.
- 서버/DB 시각을 기한 판정 기준으로 사용하며 테스트에서는 제어 가능한 clock을 주입한다.
- 결제·승인·제안의 만료는 `now >= expires_at`이면 만료로 판정한다.

## 4. 상태 전이

| 현재 상태 | 허용되는 다음 상태 | 조건 |
|---|---|---|
| HOLD | PENDING_APPROVAL / PENDING_PAYMENT / CONFIRMED | 유효한 점유, 고객 확인, 정책 평가 완료 |
| HOLD | EXPIRED / CANCELLED | 기한 만료 또는 포기 |
| PENDING_APPROVAL | PENDING_PAYMENT / CONFIRMED | 직원 승인, 기한 전, 유효한 점유 |
| PENDING_APPROVAL | CANCELLED / EXPIRED | 거절 또는 만료 |
| PENDING_PAYMENT | CONFIRMED | 검증된 결제 성공, 기한 전, 좌석 유지 |
| PENDING_PAYMENT | CANCELLED / EXPIRED | 취소 또는 만료 |
| CONFIRMED | SEATED / CANCELLED / NO_SHOW | 권한·취소 정책·방문 조건 검사 |
| SEATED | COMPLETED | 실제 퇴석 확인 |
| NO_SHOW | CONFIRMED / SEATED | 직원 복구 명령, 좌석 재확보, 사유 |

도착은 `arrived_at`으로 기록하고 착석과 구분한다. COMPLETED, CANCELLED, EXPIRED를 단순 상태 수정으로 되돌리지 않는다. 필요하면 신규 예약 또는 명시적 복구 명령을 사용한다.

퇴석 처리 시 실제 착석 기록은 종료하되 정리시간 동안의 점유는 유지한다. 조기 퇴석으로 종료시각을 줄이거나 이용 초과로 늘릴 때도 같은 점유 제약을 적용한다. 이용 초과가 다음 확정 예약과 충돌하면 DB 제약을 우회하여 연장하지 않고 현재 착석 상태와 충돌 작업을 유지한다. 직원이 다음 예약 재배정·연락 등으로 해결할 때까지 해당 테이블의 즉시 착석과 새 임박 예약 접수를 차단한다.

결제 상태는 PENDING/SUCCEEDED/FAILED/CANCELLED, 환불 상태는 REQUESTED/PROCESSING/SUCCEEDED/FAILED로 분리한다. 순서가 뒤바뀐 웹훅이 성공 거래를 실패로 덮어쓰지 못하게 한다.

## 5. 정책 계약

입력: 매장, 방문 시각, 총 인원·좌석 필요 수·요금 대상 인원, 요청 채널, 요청 시각.

출력: 허용 여부와 오류 코드, 이용시간·정리시간, 승인 필요 여부, 최소소비·예약금과 계산 근거, 취소·환불 조건, 정책 버전.

1. 명시적인 예약 차단을 검사한다.
2. 특별영업일이 있으면 요일별 영업을 대체한다.
3. 예약 오픈 기간·마감·인원·채널 제한을 모두 검사한다.
4. 각 정책 종류에서 적용되는 규칙을 선택한다. 동순위 중복은 게시 전에 차단한다.
5. 이용 종료와 점유 종료를 산출한다.
6. 활성 실제 테이블 또는 명시된 결합에서 가능한 배치를 찾는다.

배치는 기본적으로 남는 좌석이 적고, 사용 테이블 수가 적은 후보를 우선한다. 접근성·구역 요청은 지원되는 범위에서 제약으로 반영한다. 결합 최대 인원은 구성 테이블 좌석 총합 이하를 기본 검증으로 한다.

유효 정책 범위는 방문일 기준이며 게시된 버전은 불변이다. 신규 버전 게시 시 적용 기간을 원자적으로 갱신하고 중복 유효 범위를 차단한다. HOLD가 생성된 조건은 해당 기한까지만 유지한다. 새 예약·변경 견적은 현재 유효 정책을 사용한다. 결제·승인 대기 중에는 접수 당시 스냅샷을 유지한다.

직원 정책 예외는 허용된 항목만 별도 override 필드와 사유로 기록한다. 수용 인원·물리적 중복 점유는 우회할 수 없다.

## 6. 동시성 계약

PostgreSQL `btree_gist` 확장과 exclusion constraint로 활성 점유가 겹치지 않도록 한다. 배포 대상에서 확장 지원 여부를 첫 단계에 검증한다.

```sql
EXCLUDE USING gist (
  restaurant_id WITH =,
  table_id WITH =,
  occupied_period WITH &&
) WHERE (released_at IS NULL)
```

- 테이블 결합은 구성 테이블별 점유 행을 동일 트랜잭션에서 생성한다.
- 예약 생성: 입력·권한 검증 → 정책 평가 → 만료 후보 잠금·해제 → 후보 배정 → 예약·점유·스냅샷·outbox 기록 → commit.
- 만료, 결제 확정, 취소, 대기 수락은 같은 소유자 행을 잠그고 상태·기한을 다시 검사한다.
- 잠금 순서는 예약/제안 ID, 테이블 ID 순으로 통일한다. deadlock/serialization 재시도는 횟수를 제한하고 멱등성을 유지한다.
- 제약 충돌 시 제한적으로 다른 후보를 탐색한다. 모두 실패하면 `SLOT_UNAVAILABLE`을 반환한다.
- 점유 여부를 먼저 읽고 나중에 무조건 삽입하는 구현을 금지한다.
- 정책 게시·테이블 비활성·차단 등록과 예약 생성은 공유된 매장 스케줄 잠금 또는 동등한 직렬화 규칙으로 경합을 제어한다. 조회에서 확인한 설정 버전만 신뢰하지 않는다.
- 공개 HOLD는 세션·연락처·IP별 제한과 rate limit을 두고, 서버가 금액·테이블·만료시각을 결정한다. 고객이 임의 연장하지 못한다.

## 7. 예약 변경 계약

1. 변경 견적은 새 조건·정책·차액·유효기간을 반환한다. 견적만으로 좌석을 확보하지 않는다.
2. 변경 확정 요청에서 새 점유를 확보한다. 원래 점유와 새 점유가 겹치는 같은 테이블은 점유 구간의 합집합으로 보호한다. 자신의 기존 점유를 중복 삽입하지 않는다.
3. 추가 결제가 있으면 변경 요청이 기한부로 새 점유를 유지하고 기존 예약은 유효하게 둔다.
4. 결제 성공 시 원예약 version과 기한을 확인한 뒤 배정·스냅샷을 한 트랜잭션에서 교체한다.
5. 실패·만료 시 새 변경에만 필요한 점유를 해제하고 기존 점유를 복원한다. 늦게 성공한 추가 결제는 별도 환불 대상으로 처리한다.
6. 차액 환불은 변경 확정 이후 별도 환불 상태로 관리한다. 환불 실패로 새 예약을 사라지게 하지 않는다.

원예약당 활성 변경 요청은 하나만 허용한다. 변경 중 취소는 변경 점유와 결제 상태까지 포함하는 명령으로 처리한다. 위 구간 교체 알고리즘은 통합 테스트에서 같은 테이블·부분 중첩·결합 변경을 모두 검증한다.

## 8. API 계약

모든 명령 응답에는 `requestId`, 오류 시 `code`, 사용자 안내, 재시도 가능 여부를 제공한다. 공개 응답에 다른 고객 정보·내부 테이블 구성·비밀값을 반환하지 않는다.

| API | 역할 |
|---|---|
| GET /api/availability | 날짜·인원별 가능 시간; 확정 보장 아님 |
| POST /api/reservation-holds | 제한된 기간 좌석 확보·정책 결과 반환 |
| POST /api/reservations | HOLD 소유권 검증 후 제출 |
| GET /api/reservations/{id} | 직원 권한 또는 고객 관리 세션 필요 |
| POST /api/reservations/{id}/change-quotes | 변경 견적 |
| POST /api/reservations/{id}/changes | 변경 요청·원자적 적용 또는 결제 대기 |
| POST /api/reservations/{id}/cancel | 취소와 필요한 환불 요청 |
| POST /api/admin/reservations/{id}/approve | 직원 승인 |
| POST /api/admin/reservations/{id}/arrive | 도착 기록 |
| POST /api/admin/reservations/{id}/seat | 실제 착석·충돌 검사 |
| POST /api/admin/reservations/{id}/complete | 퇴석·정리시간 처리 |
| POST /api/admin/reservations/{id}/reassign | 테이블 재배정 |
| POST /api/admin/policy-versions/{id}/publish | 검증된 정책 게시 |
| POST /api/waitlist / offers/{id}/accept | 대기 등록·기한부 제안 수락 |
| POST /api/webhooks/{provider} | 제공업체 인증·서명 검증 후 이벤트 수신 |

주요 오류: SLOT_UNAVAILABLE, HOLD_EXPIRED, POLICY_CONFLICT, VERSION_CONFLICT, APPROVAL_REQUIRED, PAYMENT_PENDING, PAYMENT_AFTER_EXPIRY, FORBIDDEN, RATE_LIMITED.

생성·변경·취소·승인·결제 요청은 멱등 키를 받는다. 같은 키와 같은 요청이면 이전 결과, 같은 키와 다른 내용이면 충돌을 반환한다. 고객 관리 링크는 충분한 엔트로피의 일회 교환 토큰을 hash 저장하고 제한된 세션으로 교환한다. 예약번호만으로 조회·취소할 수 없게 한다.

## 9. 외부 연동과 worker

- `PaymentProvider`: createPayment, queryPayment, requestRefund, queryRefund, verifyWebhook.
- `NotificationProvider`: send, queryDelivery, verifyCallback.
- `VoiceProvider`: 검증된 webhook 수신, 통화·직원 연결 명령, 장애 fallback.
- Adapter별 오류를 재시도 가능·영구 실패·결과 불명으로 구분한다.
- 외부 호출은 DB 트랜잭션 밖에서 실행한다. provider 멱등 키 또는 결과 조회로 중복 부작용을 줄인다.
- outbox/job은 적어도 한 번 처리될 수 있다고 가정한다. DB lease와 `FOR UPDATE SKIP LOCKED`, 제한된 재시도·backoff·실패 큐를 구현한다.
- 결제·환불 결과가 불명확하면 새 거래를 무조건 생성하지 않고 조회·대사한다.
- SMS 중복을 완전히 방지할 수 없는 업체는 결과 불명 시 자동 재발송 정책을 별도로 둔다.
- 정기 작업: 점유 만료, 승인 기한 경고, No-show 후보, 결제·환불 대사, 실패 발송, 개인정보 정리.
- worker 중단 후 재시작하면 미처리 작업을 복구하고 이미 성공한 외부 작업을 중복 실행하지 않는지 검사한다.

## 10. 보안·운영 계약

관리자는 검증된 인증 라이브러리와 세션을 사용하고 중요한 권한에는 MFA를 지원한다. 서버에서 역할·매장·대상 권한을 검사한다. 쿠키 보안·CSRF 또는 동등한 origin 검증·입력 검증·rate limit을 적용한다.

비밀값은 배포 환경의 비밀 저장소 또는 암호화 저장과 분리된 키로 관리한다. 설정 화면은 마스킹·교체·연결 테스트만 제공한다. `.env.example`에는 값 없는 이름과 설명만 작성한다. HTTP 요청·로그·오류 추적에서 전화번호·관리 토큰·결제 비밀·녹취 URL을 제거하거나 마스킹한다.

감사 로그에는 행위자·사유·변경 내역을 남기고 일반 직원이 수정·삭제할 수 없게 한다. 보관·익명화 작업은 운영자가 확정한 기간과 회계상 보존 예외를 따른다. 접근성은 모바일·키보드·명확한 오류 안내를 포함한다.

운영 지표: 예약 오류율, 점유 충돌률, 승인 지연, worker heartbeat, 작업 지연, 결제 불일치, 환불 실패, 알림 실패, DB 연결·백업 상태. health endpoint는 세부 비밀을 노출하지 않는다.
