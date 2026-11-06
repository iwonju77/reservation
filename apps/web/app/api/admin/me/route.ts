import { AuthError, authorizeRestaurant } from "@reservation/auth";
import { sessionSecret } from "@reservation/shared";
import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { authErrorResponse, SESSION_COOKIE } from "../../../../lib/auth-http";
import { database } from "../../../../lib/database";

export async function GET(request: NextRequest): Promise<NextResponse> {
  try {
    const token = request.cookies.get(SESSION_COOKIE)?.value;
    if (!token) throw new AuthError("UNAUTHENTICATED", "Session cookie is missing");
    const restaurantId = z.string().uuid().safeParse(request.nextUrl.searchParams.get("restaurantId"));
    if (!restaurantId.success) {
      return NextResponse.json(
        { error: { code: "INVALID_INPUT", message: "매장 정보가 올바르지 않습니다." } },
        { status: 400 },
      );
    }
    const context = await authorizeRestaurant({
      pool: database,
      token,
      secret: sessionSecret(),
      restaurantId: restaurantId.data,
      minimumRole: "STAFF",
    });
    return NextResponse.json({ user: context });
  } catch (error) {
    return authErrorResponse(error);
  }
}
