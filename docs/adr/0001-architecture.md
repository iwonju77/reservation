# ADR 0001: 초기 애플리케이션 구조

- 상태: 승인된 개발 기준
- 날짜: 2026-11-06 (Asia/Taipei)

## 결정

예약 시스템은 pnpm monorepo의 Next.js 웹/API, 별도 Node.js worker, PostgreSQL로 시작한다. 공통 런타임 검증은 shared 패키지, DB 연결과 SQL migration은 db 패키지에 둔다. migration runner는 적용한 파일의 SHA-256을 DB에 기록하고 변경을 거부하며 PostgreSQL advisory lock 아래에서 파일별 트랜잭션을 실행한다.

Node.js 24, Next.js 16.4.5, React 19.3.1, TypeScript 5.9.3을 고정한다. 2026-11-06 기준 레지스트리의 안정성 태그와 요구사항을 확인했다.

개발 PostgreSQL은 Docker Compose로 실행한다. 운영 배포 대상은 아직 정하지 않으며, 관리형 PostgreSQL·상시 worker·TLS·백업 복원을 지원해야 한다.

## 이유

한 저장소와 DB 트랜잭션 안에서 예약·정책·좌석 점유를 처리하면 초기 운영 복잡도를 낮추면서 PostgreSQL exclusion constraint로 중복 예약을 보장할 수 있다. worker는 만료와 외부 연동을 웹 요청에서 분리한다.

## 현재 제한

Step 1 migration에는 연결 검증용 heartbeat만 있다. 예약 도메인 모델, 인증, 실제 작업 lease는 이후 단계에서 추가한다. E2E와 개발 seed 명령은 의도적으로 실패하며 해당 단계에서 구현한다. 실제 매장 정책과 외부 업체는 미확정이다.

Prisma CLI는 공식 바이너리 서버가 현재 클라우드 네트워크 정책에서 403으로 차단되므로 채택하지 않았다. 체크섬 검증을 끄거나 바이너리를 우회하지 않았다. 이 시스템은 PostgreSQL 고유 제약과 명시적 SQL이 중요해 `pg` 기반 runner가 요구사항에 더 직접적으로 맞는다.
