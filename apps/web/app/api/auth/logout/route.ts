import { logout } from "@reservation/auth";
import { sessionSecret } from "@reservation/shared";
import { NextResponse, type NextRequest } from "next/server";
import { assertSameOrigin, authErrorResponse, SESSION_COOKIE } from "../../../../lib/auth-http";
import { database } from "../../../../lib/database";

export async function POST(request: NextRequest): Promise<NextResponse> {
  const originError = assertSameOrigin(request);
  if (originError) return originError;
  try {
    const token = request.cookies.get(SESSION_COOKIE)?.value;
    if (token) await logout({ pool: database, token, secret: sessionSecret() });
    const response = NextResponse.json({ loggedOut: true });
    response.cookies.set(SESSION_COOKIE, "", {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      path: "/",
      maxAge: 0,
    });
    return response;
  } catch (error) {
    return authErrorResponse(error);
  }
}
