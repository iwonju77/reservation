# 구현 진행 상황

최종 문서 작성일: 2026-11-07 (Asia/Taipei)

현재 상태: Step 00~03 구현과 검증 완료. 브랜치는 `main`이며 PostgreSQL migration 4개가 적용돼 있다.

## 단계 추적

| 단계 | 작업 | 상태 | 검증 증거 / blocker |
|---|---|---|---|
| 00 | 저장소·결정 기록 | DONE | 기존 변경 보존, 런타임·네트워크·Docker 확인, ADR 0001 작성 |
| 01 | 프로젝트 기반 | DONE | pnpm frozen 설치, lint·typecheck·단위/DB 통합 테스트·build, 웹/DB health·worker heartbeat 통과 |
| 02 | DB·migration | DONE | 빈 DB·upgrade migration, 개발 seed 반복 실행, 실제 PostgreSQL 제약·동시성 테스트 통과 |
| 03 | 인증·권한 | DONE | DB 세션·역할·계정 잠금/폐기·감사 마스킹, 13개 PostgreSQL 통합 테스트와 production build 통과 |
| 04 | 운영 설정 | TODO | — |
| 05 | 예약 엔진 | TODO | — |
| 06 | 직원 현장 운영 | TODO | — |
| 07 | 고객 웹 | TODO | — |
| 08 | worker·SMS | TODO | 업체·계정 미확정 |
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

Step 00~03이 완료됐다. 다음 작업은 Step 04의 테이블·영업시간·정책 관리다. 실제 운영값이 없어도 개발 fixture로 시작할 수 있다. 운영 공개는 활성 기능의 외부 검증과 운영자 확정이 완료된 후 수행한다.

## v2 개정 이력

- 외부 에이전트 전달 문서를 직접 개발 절차로 교체.
- 실제 저장소 상태와 첫 구현 범위, 화면 구성, 마일스톤 명시.
- 기본 worker를 MVP 단계로 당기고 무결제 변경과 결제 수반 변경의 의존성을 분리.
- 정책 내용의 불변 버전과 적용 일정, 예약 HOLD의 정체성, 점유 소유권을 구체화.
- 애플리케이션 테스트와 실제 서비스 실행은 아직 하지 않음.
