import { AuthError, authorizeRestaurant } from "@reservation/auth";
import { sessionSecret } from "@reservation/shared";
import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { authErrorResponse, SESSION_COOKIE } from "../../../../../../lib/auth-http";
import { database } from "../../../../../../lib/database";

const roleSchema = z.enum(["STAFF", "MANAGER", "SYSTEM_ADMIN"]);

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ restaurantId: string }> },
): Promise<NextResponse> {
  try {
    const token = request.cookies.get(SESSION_COOKIE)?.value;
    if (!token) throw new AuthError("UNAUTHENTICATED", "Session cookie is missing");
    const { restaurantId } = await context.params;
    const validRestaurant = z.string().uuid().safeParse(restaurantId);
    const minimumRole = roleSchema.safeParse(request.nextUrl.searchParams.get("minimumRole") ?? "STAFF");
    if (!validRestaurant.success || !minimumRole.success) {
      return NextResponse.json(
        { error: { code: "INVALID_INPUT", message: "권한 요청 정보가 올바르지 않습니다." } },
        { status: 400 },
      );
    }
    const user = await authorizeRestaurant({
      pool: database,
      token,
      secret: sessionSecret(),
      restaurantId: validRestaurant.data,
      minimumRole: minimumRole.data,
    });
    return NextResponse.json({ authorized: true, user });
  } catch (error) {
    return authErrorResponse(error);
  }
}
