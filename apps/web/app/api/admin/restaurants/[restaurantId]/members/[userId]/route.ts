import { AuthError, deactivateUser } from "@reservation/auth";
import { sessionSecret } from "@reservation/shared";
import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { assertSameOrigin, authErrorResponse, SESSION_COOKIE } from "../../../../../../../lib/auth-http";
import { database } from "../../../../../../../lib/database";

const deactivateSchema = z.object({ reason: z.string().trim().min(1).max(500) });

export async function PATCH(
  request: NextRequest,
  context: { params: Promise<{ restaurantId: string; userId: string }> },
): Promise<NextResponse> {
  const originError = assertSameOrigin(request);
  if (originError) return originError;
  try {
    const token = request.cookies.get(SESSION_COOKIE)?.value;
    if (!token) throw new AuthError("UNAUTHENTICATED", "Session cookie is missing");
    const { restaurantId, userId } = await context.params;
    const validRestaurant = z.string().uuid().safeParse(restaurantId);
    const validUser = z.string().uuid().safeParse(userId);
    const body = deactivateSchema.safeParse(await request.json());
    if (!validRestaurant.success || !validUser.success || !body.success) {
      return NextResponse.json(
        { error: { code: "INVALID_INPUT", message: "비활성화 정보를 확인해주세요." } },
        { status: 400 },
      );
    }
    await deactivateUser({
      pool: database,
      actorToken: token,
      secret: sessionSecret(),
      restaurantId: validRestaurant.data,
      targetUserId: validUser.data,
      reason: body.data.reason,
    });
    return NextResponse.json({ deactivated: true });
  } catch (error) {
    return authErrorResponse(error);
  }
}
