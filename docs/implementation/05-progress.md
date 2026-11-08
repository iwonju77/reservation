# 구현 진행 상황

최종 문서 작성일: 2026-11-08 (Asia/Taipei)

현재 상태: Step 00~07 완료, Step 08 개발 기반 완료·실 SMS 연동 BLOCKED. PostgreSQL migration 12개가 적용돼 있다.

## 단계 추적

| 단계 | 작업 | 상태 | 검증 증거 / blocker |
|---|---|---|---|
| 00 | 저장소·결정 기록 | DONE | 기존 변경 보존, 런타임·네트워크·Docker 확인, ADR 0001 작성 |
| 01 | 프로젝트 기반 | DONE | pnpm frozen 설치, lint·typecheck·단위/DB 통합 테스트·build, 웹/DB health·worker heartbeat 통과 |
| 02 | DB·migration | DONE | 빈 DB·upgrade migration, 개발 seed 반복 실행, 실제 PostgreSQL 제약·동시성 테스트 통과 |
| 03 | 인증·권한 | DONE | DB 세션·역할·계정 잠금/폐기·감사 마스킹, 13개 PostgreSQL 통합 테스트와 production build 통과 |
| 04 | 운영 설정 | DONE | 테이블·결합·영업시간·특별일·차단·정책 관리, PostgreSQL 통합/불변성 검증과 관리자 화면 통과 |
| 05 | 예약 엔진 | DONE | 정책 평가·가용성·HOLD·제출·만료·멱등·outbox·worker lease와 PostgreSQL 동시성 검증 통과 |
| 06 | 직원 현장 운영 | DONE | 당일 보드·직원/현장 예약·상태 전이·착석·재배정·연장·무결제 변경·No-show 복구 검증 통과 |
| 07 | 고객 웹 | DONE | 번체중문/한국어 모바일 예약·HOLD 복구·동의·관리 토큰·조회·취소·무결제 변경 검증 통과 |
| 08 | worker·SMS | BLOCKED | Provider·fake·템플릿·outbox lease·발송 이력 완료. 실제 업체·계정·발신번호 미확정 |
| 09 | 결제·환불 | TODO | 업체·계정·실제 금액 정책 미확정 |
| 10 | 예약 변경 | TODO | — |
| 11 | 대기명단 | TODO | — |
| 12 | 운영 안정성 | TODO | 배포 환경·보관기간·복구 목표 확정 필요 |
| 13 | 현장 인수·출시 | TODO | 실제 매장 데이터와 운영자 인수 필요 |
| 14 | 전화 AI·확장 | TODO | 통신사 연결 방식·제공업체 미확정 |

상태는 TODO / IN_PROGRESS / DONE / BLOCKED를 사용한다. 부분 완료는 IN_PROGRESS로 두고 세부 완료 내용을 기록한다. 외부 blocker는 실제로 필요한 시점에 BLOCKED로 전환한다.

## 결정 기록

| 날짜 | 항목 | 결정 / 제안 | 확정 여부 | 근거 |
|---|---|---|---|---|
| 2026-11-06 | 개발 방식 | 이 채팅의 Codex가 공유 저장소에서 직접 구현 | 사용자 결정 | 외부 도구 인계 중단, 직접 개발용 설계 요청 |
| 2026-11-06 | 첫 기능 목표 | 직원용 예약·좌석 관리 MVP | 설계 기준 | 외부 업체 없이 핵심 예약 정확성 검증 |
| 2026-11-06 | 기술 구조 | Next.js + PostgreSQL + 별도 worker | 제안 | 단일 예약 엔진, DB 동시성 보호 |
| 2026-11-06 | 시간대·통화 | Asia/Taipei / TWD | 운영자 확인 필요 | 기존 문서의 대만 전화·통화 예시 |
| 2026-11-06 | 자동 No-show | 초기 OFF | 제안 | 현장 오처리 방지 |
| 2026-11-06 | Node·웹 기반 | Node 24, Next.js 16.4.5, React 19.3.1, TypeScript 5.9.3 | 개발 기준 | 레지스트리 안정 버전과 요구사항 확인 |
| 2026-11-06 | DB migration | PostgreSQL SQL 파일 + SHA-256 이력 + advisory lock | 개발 기준 | Prisma 바이너리 서버가 정책상 403, 검증 비활성화 없이 대체 |
| 2026-11-07 | 직원 인증 | bcrypt 비밀번호 + JWT 쿠키 + DB 세션·실시간 멤버십 검사 | 개발 기준 | 퇴사·역할 변경을 즉시 반영하고 매장 간 접근 차단 |
| 2026-11-07 | 정책 게시 | DRAFT 새 버전 + 날짜 범위 게시 + 게시 후 DB 불변성 | 개발 기준 | 운영 변경 이력과 예약 평가 재현성 보존 |
| 2026-11-08 | 예약 좌석 확보 | 10분 HOLD + 실제 테이블별 allocation + DB exclusion constraint | 개발 기준 | 단독·결합 좌석의 마지막 동시 요청을 DB에서 직렬화 |
| 2026-11-08 | 설정·예약 경합 | 예약 shared / 설정 exclusive advisory lock | 개발 기준 | 차단·정책 변경과 예약 생성의 불일치 방지 |
| 2026-11-08 | 현장 변경 | reservation version + 원자적 allocation 교체 | 개발 기준 | 직원 동시 조작과 변경 실패 때 원예약 보존 |
| 2026-11-08 | 고객 관리 권한 | URL fragment 원문 토큰 + DB SHA-256 해시 | 개발 기준 | 예약번호 추측 접근 차단과 서버 로그 노출 축소 |

## 테스트 기록

아직 실행한 애플리케이션 테스트 없음. 아래 양식으로 추가한다.

설계 v2 문서 검증: `git diff --check` 통과, Markdown 6개의 상대 링크·코드 블록 닫힘·Step 00~14 순서 검사 통과. 이는 문서 정합성 검증이며 앱 기능 테스트 결과가 아니다.

Step 01 실행 증거(2026-11-06 Asia/Taipei):

- `pnpm install --frozen-lockfile`: 성공. pnpm 11.25.0 supply-chain 검사 통과.
- `pnpm lint`, `pnpm typecheck`: 성공.
- `pnpm test:unit`: 1 file, 2 tests 통과.
- `pnpm test:integration`: 실제 PostgreSQL 17에서 1 file, 1 test 통과.
- `pnpm build`: Next.js 웹과 shared·worker production build 성공.
- migration: 1개 적용, pending 0, `btree_gist`와 heartbeat 테이블 생성.
- `pnpm worker:once`: DB heartbeat 기록 성공.
- 실제 웹 실행: `/`, `/health/live`, `/health/ready` 모두 HTTP 200. readiness가 DB ready 확인.
- `test:e2e`, `db:seed:dev`: 후속 단계 전까지 의도적으로 미구현이며 실행 시 실패. Step 01 기능을 통과했다고 계산하지 않음.
- Prisma CLI 시도: 공식 바이너리 서버가 403으로 거부. 체크섬 우회 없이 제거하고 검증 가능한 SQL runner로 전환.

Step 02 실행 증거(2026-11-06 Asia/Taipei):

- 예약 도메인 migration 2개 추가. 전체 적용 migration 3개, pending 0.
- 별도 빈 DB에서 migration 3개를 처음부터 적용하고 pending 0 확인 후 검증 DB 삭제.
- 개발 fixture를 연속 2회 실행해 같은 매장·테이블·결합·영업시간·정책이 중복되지 않음을 확인.
- 실제 PostgreSQL 통합 테스트: 2 files, 7 tests 통과.
- 같은 마지막 테이블에 10개 동시 점유 요청: 1개 성공, 9개 `23P01` 충돌.
- 결합 테이블과 단독 테이블 충돌, 반개구간 경계 허용, 해제 점유 재사용, 매장 간 FK, 활성 착석 중복, 정책 적용기간 중복 검증.
- 시간 유틸리티 단위 테스트를 포함한 전체 단위 테스트 결과는 최종 검사 기록을 따른다.

Step 03 실행 증거(2026-11-07 Asia/Taipei):

- 인증 migration 추가. 전체 적용 migration 4개, pending 0.
- bcrypt 비용 12 비밀번호, 8시간 DB 세션, HttpOnly·SameSite 쿠키, 로그인 5회 실패 시 15분 잠금을 구현.
- STAFF·MANAGER·SYSTEM_ADMIN 역할과 요청별 활성 세션·사용자·매장 멤버십 검사를 구현.
- 로그인·로그아웃·현재 권한·계정 생성·계정 비활성화 API와 직원 로그인 화면을 production build로 검증.
- 실제 PostgreSQL 통합 테스트: 전체 3 files, 13 tests 통과. 다른 매장, 낮은 역할, 비활성 계정, 잠금, 세션 폐기, 감사 로그 마스킹을 포함.
- `pnpm lint`, `pnpm typecheck`, `pnpm test:unit`, `pnpm build` 성공.
- MFA 강제 게이트와 세션 검증 필드는 준비했다. 실제 MFA 등록·검증 수단은 운영 인증 제공 방식 확정 후 연결하며 현재 계정에는 활성화하지 않는다.

Step 04 실행 증거(2026-11-07 Asia/Taipei):

- 테이블 생성·수정·비활성화, 활성 좌석 합계, 결합 테이블 구성원 생성·변경·비활성화를 구현.
- 요일별 복수 영업 구간, 익일 종료, 주 경계 충돌 검사, 특별영업·임시휴무, 테이블 예약 차단을 구현.
- 정책 필수 규칙 검증, 초안 버전, 조건 미리보기, 날짜 범위 게시, 적용 일정 중복 거부를 구현.
- 게시 정책과 규칙의 수정·직접 삭제를 DB 트리거로 거부하고 정상 FK 연쇄 동작은 보존.
- MANAGER 이상 서버 권한, 동일 출처 검사, 설정 변경 감사 로그와 영향 확인 응답을 적용.
- 관리자 `/admin/operations` 화면과 운영 설정 API를 production build로 검증.
- 실제 PostgreSQL 통합 테스트 전체 4 files, 19 tests 통과. 전체 migration 7개, pending 0.

Step 05 실행 증거(2026-11-08 Asia/Taipei):

- 정책 평가, 가용성 조회, 10분 HOLD 생성, 같은 예약 ID 제출과 상태 전이를 구현.
- 영업시간·특별일·차단·비활성 좌석, 이용시간·정리시간·시작 간격·예약 오픈/마감을 후보 계산에 적용.
- 단독·결합 테이블을 실제 테이블별로 점유하고 정책 스냅샷·상태 이벤트·outbox·만료 작업을 한 트랜잭션에 기록.
- 동일 멱등 요청 재사용, 다른 payload 충돌, 고객 세션 소유권, 예상 version, 활성 HOLD 3개 제한을 구현.
- worker `SKIP LOCKED` claim, lease, savepoint 실패 기록, 재시도, HOLD 만료와 점유 해제를 구현. 요청 경로에서도 만료 정리.
- 승인 필요 예약은 `PENDING_APPROVAL`, 예약금 필요 예약은 `PENDING_PAYMENT`, 그 외만 `CONFIRMED`로 전이.
- PostgreSQL 통합 테스트 전체 5 files, 29 tests 통과. 마지막 테이블 20개 동시 요청 중 1개 성공을 포함.
- migration 10개, pending 0. production build에서 가용성·HOLD·제출 API와 worker 컴파일 성공.

Step 06 실행 증거(2026-11-08 Asia/Taipei):

- 영업일별 예약 목록·테이블 착석 상태·검색·상태 필터·30초 갱신·인쇄용 당일표 화면 구현.
- 직원 예약·현장 방문을 공통 HOLD 엔진에 연결하고 승인·거절·도착·착석·퇴석 상태 전이 구현.
- reservation version으로 직원 동시 조작을 거부하고 상태 이벤트·감사 로그에 직원 콘솔 출처 기록.
- 테이블 재배정, 이용 연장, 예약금 없는 날짜·인원 변경을 원자적 allocation 교체로 구현. 충돌 시 원예약 보존.
- No-show 처리 시 점유 해제, 복구 시 이전 테이블 재확보, 착석 점유와 예약 점유의 분리 표시 구현.
- PostgreSQL 통합 테스트 전체 6 files, 32 tests 통과. 직원 동시 도착 요청, 착석·퇴석, 재배정, 연장·변경 rollback, No-show 복구 포함.

Step 07 실행 증거(2026-11-08 Asia/Taipei):

- 번체중문·한국어 모바일 예약 화면에 날짜·인원·시간 가용성, 멱등 HOLD, 남은 시간, 새로고침 복구, 연락처·동의 제출 구현.
- 약관·개인정보 문서 버전, 언어, 동의 시각 저장. 관리 토큰은 원문을 한 번만 반환하고 DB에는 SHA-256 해시만 저장.
- Bearer 관리 토큰 기반 예약 조회·취소·무결제 날짜/시간/인원 변경 구현. 잘못된 토큰과 version 충돌 거부.
- 예약금이 있는 변경은 결제 차액 처리가 구현되는 Step 10 전까지 명시적으로 거부.
- PostgreSQL 통합 테스트 전체 6 files, 33 tests 통과. 고객 토큰 소유권, 원자적 변경과 취소 포함.

Step 08 개발 기반 실행 증거(2026-11-08 Asia/Taipei):

- NotificationProvider 계약, 개발 Fake, 언어·버전 템플릿, 발송 이력과 재시도 상태 구현.
- outbox `SKIP LOCKED` claim·lease, 이벤트/채널 유일키 멱등 소비, 수신번호 누락 처리 구현.
- worker heartbeat·HOLD 만료와 같은 루프에 알림 outbox 소비·재시도 연결.
- PostgreSQL 통합 테스트 전체 7 files, 34 tests 통과. 동일 이벤트 fake SMS 1회 발송 검증.
- 실제 SMS 업체 Adapter·콜백·실발송은 업체와 계정이 확정되지 않아 BLOCKED.

```text
일시 / commit 또는 작업 revision:
단계 / 실행 환경:
명령:
종료 코드:
실행 수 / 성공 / 실패 / skip:
결과 파일 경로:
실패 원인과 조치:
외부 연동 수준(fake/sandbox/실계정):
```

## 출시 점검표

- [ ] 실제 매장 데이터와 운영 정책 확정
- [ ] 활성 기능의 필수 테스트 통과
- [ ] 직원 인수 시나리오 통과
- [ ] 필요한 외부 제공업체 실연동 검증
- [ ] 비밀정보·권한·개인정보 처리 검증
- [ ] 백업 복원 실측 및 장애 운영 절차 확인
- [ ] 배포·마이그레이션·앱 버전 복구 리허설
- [ ] 출시 범위·시점·운영 담당자 확정

## 다음 작업

다음 독립 구현은 Step 09 결제 기반이다. Step 08 실연동을 해제하려면 SMS 업체·계정·발신번호·테스트 수신처 확정이 필요하다.

## v2 개정 이력

- 외부 에이전트 전달 문서를 직접 개발 절차로 교체.
- 실제 저장소 상태와 첫 구현 범위, 화면 구성, 마일스톤 명시.
- 기본 worker를 MVP 단계로 당기고 무결제 변경과 결제 수반 변경의 의존성을 분리.
- 정책 내용의 불변 버전과 적용 일정, 예약 HOLD의 정체성, 점유 소유권을 구체화.
- 애플리케이션 테스트와 실제 서비스 실행은 아직 하지 않음.
