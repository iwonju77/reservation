import { submitHold } from "@reservation/reservation-engine";
import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { assertSameOrigin } from "../../../../../lib/auth-http";
import { database } from "../../../../../lib/database";
import { GUEST_COOKIE, reservationErrorResponse } from "../../../../../lib/reservation-http";

const bodySchema = z.object({ expectedVersion: z.number().int().positive() });
export async function POST(request: NextRequest, route: { params: Promise<{ reservationId: string }> }): Promise<NextResponse> {
  const originError = assertSameOrigin(request); if (originError) return originError;
  try {
    const reservationId = z.string().uuid().parse((await route.params).reservationId);
    const ownerScope = request.cookies.get(GUEST_COOKIE)?.value;
    const body = bodySchema.safeParse(await request.json());
    if (!ownerScope || !body.success) return NextResponse.json({ error: { code: "INVALID_INPUT", message: "HOLD 정보를 확인해주세요." } }, { status: 400 });
    return NextResponse.json(await submitHold({ pool: database, reservationId, ownerScope, expectedVersion: body.data.expectedVersion }));
  } catch (error) { return reservationErrorResponse(error); }
}
