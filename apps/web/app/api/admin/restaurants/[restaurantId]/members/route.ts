import { AuthError, createMemberAccount } from "@reservation/auth";
import { sessionSecret } from "@reservation/shared";
import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { assertSameOrigin, authErrorResponse, SESSION_COOKIE } from "../../../../../../lib/auth-http";
import { database } from "../../../../../../lib/database";

const memberSchema = z.object({
  email: z.string().email().max(254),
  displayName: z.string().trim().min(1).max(100),
  password: z.string().min(12).max(128),
  role: z.enum(["STAFF", "MANAGER", "SYSTEM_ADMIN"]),
});

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ restaurantId: string }> },
): Promise<NextResponse> {
  const originError = assertSameOrigin(request);
  if (originError) return originError;
  try {
    const token = request.cookies.get(SESSION_COOKIE)?.value;
    if (!token) throw new AuthError("UNAUTHENTICATED", "Session cookie is missing");
    const { restaurantId } = await context.params;
    const validRestaurant = z.string().uuid().safeParse(restaurantId);
    const body = memberSchema.safeParse(await request.json());
    if (!validRestaurant.success || !body.success) {
      return NextResponse.json(
        { error: { code: "INVALID_INPUT", message: "계정 정보를 확인해주세요." } },
        { status: 400 },
      );
    }
    const member = await createMemberAccount({
      pool: database,
      actorToken: token,
      secret: sessionSecret(),
      restaurantId: validRestaurant.data,
      ...body.data,
    });
    return NextResponse.json(member, { status: 201 });
  } catch (error) {
    return authErrorResponse(error);
  }
}
