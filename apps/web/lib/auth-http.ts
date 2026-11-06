import { AuthError } from "@reservation/auth";
import { NextResponse, type NextRequest } from "next/server";

export const SESSION_COOKIE = "reservation_session";

export function assertSameOrigin(request: NextRequest): NextResponse | undefined {
  const origin = request.headers.get("origin");
  if (!origin || origin !== request.nextUrl.origin) {
    return NextResponse.json(
      { error: { code: "INVALID_ORIGIN", message: "요청 출처를 확인할 수 없습니다." } },
      { status: 403 },
    );
  }
}

export function authErrorResponse(error: unknown): NextResponse {
  if (error instanceof AuthError) {
    const status = error.code === "UNAUTHENTICATED" || error.code === "INVALID_CREDENTIALS"
      ? 401
      : error.code === "ACCOUNT_LOCKED"
        ? 423
        : 403;
    const message = error.code === "INVALID_CREDENTIALS"
      ? "이메일 또는 비밀번호가 올바르지 않습니다."
      : error.code === "ACCOUNT_LOCKED"
        ? "로그인 시도가 많아 계정이 잠시 잠겼습니다."
        : error.code === "MFA_REQUIRED"
          ? "추가 인증이 필요합니다."
          : status === 401
            ? "로그인이 필요합니다."
            : "이 작업을 수행할 권한이 없습니다.";
    return NextResponse.json({ error: { code: error.code, message } }, { status });
  }
  console.error(JSON.stringify({ level: "error", event: "auth.request_failed" }));
  return NextResponse.json(
    { error: { code: "INTERNAL_ERROR", message: "요청을 처리하지 못했습니다." } },
    { status: 500 },
  );
}
