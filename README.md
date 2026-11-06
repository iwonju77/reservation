# 서울아저씨 예약 시스템

예약·좌석·운영 정책을 하나의 예약 엔진에서 관리하는 웹 애플리케이션이다. 현재 Step 1 실행 기반까지 구성한다.

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
pnpm dev
```

다른 터미널에서 worker를 실행한다.

```sh
pnpm worker:dev
```

웹은 `http://127.0.0.1:3000`, liveness는 `/health/live`, DB readiness는 `/health/ready`에서 확인한다. 서비스를 종료할 때 웹과 worker 프로세스를 종료한 뒤 `pnpm db:down`을 실행한다. PostgreSQL 데이터는 Compose volume에 남는다.

## 검증

```sh
pnpm lint
pnpm typecheck
pnpm test:unit
pnpm test:integration
pnpm build
pnpm worker:once
```

`test:integration`과 `worker:once`에는 실행 중인 PostgreSQL과 적용된 migration이 필요하다. `test:e2e`와 `db:seed:dev`는 후속 단계 전까지 명시적으로 실패한다.

상세 설계와 진행 상황은 [`docs/implementation/README.md`](docs/implementation/README.md)에서 확인한다.
