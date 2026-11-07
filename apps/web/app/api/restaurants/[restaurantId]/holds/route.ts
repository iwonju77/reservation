import { randomUUID } from "node:crypto";
import { createHold } from "@reservation/reservation-engine";
import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { assertSameOrigin } from "../../../../../lib/auth-http";
import { database } from "../../../../../lib/database";
import { GUEST_COOKIE, reservationErrorResponse } from "../../../../../lib/reservation-http";

const bodySchema = z.object({ businessDate: z.string().date(), startsAt: z.string().datetime(), partySize: z.number().int().positive().max(100), seatCount: z.number().int().positive().max(100).optional() });
export async function POST(request: NextRequest, route: { params: Promise<{ restaurantId: string }> }): Promise<NextResponse> {
  const originError = assertSameOrigin(request); if (originError) return originError;
  try {
    const restaurantId = z.string().uuid().parse((await route.params).restaurantId);
    const body = bodySchema.safeParse(await request.json());
    const idempotencyKey = request.headers.get("idempotency-key");
    if (!body.success || !idempotencyKey || idempotencyKey.length > 200) return NextResponse.json({ error: { code: "INVALID_INPUT", message: "예약 요청 또는 멱등 키를 확인해주세요." } }, { status: 400 });
    const ownerScope = request.cookies.get(GUEST_COOKIE)?.value ?? randomUUID();
    const result = await createHold({ pool: database, restaurantId, ownerScope, idempotencyKey, businessDate: body.data.businessDate, startsAt: new Date(body.data.startsAt), partySize: body.data.partySize, seatCount: body.data.seatCount });
    const response = NextResponse.json(result, { status: 201 });
    response.cookies.set(GUEST_COOKIE, ownerScope, { httpOnly: true, secure: process.env.NODE_ENV === "production", sameSite: "lax", path: "/", maxAge: 86_400, priority: "high" });
    return response;
  } catch (error) { return reservationErrorResponse(error); }
}
