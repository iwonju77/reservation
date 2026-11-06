import { loginWithPassword } from "@reservation/auth";
import { sessionSecret } from "@reservation/shared";
import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { assertSameOrigin, authErrorResponse, SESSION_COOKIE } from "../../../../lib/auth-http";
import { database } from "../../../../lib/database";

const loginSchema = z.object({
  email: z.string().email().max(254),
  password: z.string().min(1).max(128),
});

export async function POST(request: NextRequest): Promise<NextResponse> {
  const originError = assertSameOrigin(request);
  if (originError) return originError;
  try {
    const parsed = loginSchema.safeParse(await request.json());
    if (!parsed.success) {
      return NextResponse.json(
        { error: { code: "INVALID_INPUT", message: "로그인 정보를 확인해주세요." } },
        { status: 400 },
      );
    }
    const result = await loginWithPassword({
      pool: database,
      email: parsed.data.email,
      password: parsed.data.password,
      secret: sessionSecret(),
    });
    const response = NextResponse.json({ user: result.user, expiresAt: result.expiresAt.toISOString() });
    response.cookies.set(SESSION_COOKIE, result.token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      path: "/",
      expires: result.expiresAt,
      priority: "high",
    });
    return response;
  } catch (error) {
    return authErrorResponse(error);
  }
}
