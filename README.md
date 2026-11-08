# 서울아저씨 예약 시스템

예약·좌석·운영 정책을 하나의 예약 엔진에서 관리하는 웹 애플리케이션이다. 현재 Step 6 직원 현장 운영까지 구성했다.

## 요구사항

- Node.js 24
- pnpm 11.25
- Docker 및 Docker Compose

## 로컬 실행

```sh
cp .env.example .env
cp .env.example apps/web/.env.local
pnpm install --frozen-lockfile
pnpm db:up
pnpm db:migrate:deploy
pnpm db:seed:dev
pnpm dev
```

다른 터미널에서 worker를 실행한다.

```sh
pnpm worker:dev
```

웹은 `http://127.0.0.1:3000`, liveness는 `/health/live`, DB readiness는 `/health/ready`에서 확인한다. 서비스를 종료할 때 웹과 worker 프로세스를 종료한 뒤 `pnpm db:down`을 실행한다. PostgreSQL 데이터는 Compose volume에 남는다.

직원 로그인은 `/login`에서 시작한다. 공용 기본 계정이나 기본 비밀번호는 제공하지 않는다. 계정은 권한이 있는 관리자가 관리자 API로 발급하며, 최초 운영 계정의 안전한 발급 절차는 배포 환경과 비밀 관리 방식이 확정되는 Step 12에서 구성한다. `SESSION_SECRET`은 환경마다 서로 다른 32자 이상의 값으로 교체해야 한다.

MANAGER와 SYSTEM_ADMIN은 로그인 후 `/admin/operations?restaurantId=<매장 UUID>`에서 테이블, 영업시간, 특별일과 예약 정책을 관리한다. 정책은 초안으로 만든 뒤 적용 기간을 지정해 게시하며 게시된 버전은 수정할 수 없다.

예약 엔진 API는 가용성 조회, HOLD 생성과 제출을 제공한다. HOLD 생성 요청에는 `Idempotency-Key` 헤더가 필요하며 브라우저의 HttpOnly 익명 세션 쿠키가 소유권을 유지한다. worker는 HOLD 만료와 점유 해제를 처리한다.

직원은 로그인 후 `/admin/floor?restaurantId=<매장 UUID>`에서 당일 예약과 테이블 상태를 확인하고 예약 등록, 승인, 도착, 착석, 퇴석과 No-show 복구를 처리한다.

## 검증

```sh
pnpm lint
pnpm typecheck
pnpm test:unit
pnpm test:integration
pnpm build
pnpm worker:once
```

`test:integration`, `worker:once`, `db:seed:dev`에는 실행 중인 PostgreSQL과 적용된 migration이 필요하다. `test:e2e`는 고객·직원 화면이 구현되는 후속 단계 전까지 명시적으로 실패한다.

`db:seed:dev`는 `APP_ENV=development`이면서 DB 이름이 `_dev`로 끝날 때만 실행된다. 단독 테이블 4개, 2개·3개 결합, 주간·자정 경과 영업시간, 특별 휴무, 기본 정책 fixture를 반복 실행 가능하게 등록한다. 운영 DB 초기화에는 사용하지 않는다.

상세 설계와 진행 상황은 [`docs/implementation/README.md`](docs/implementation/README.md)에서 확인한다.
