import { submitHold } from "@reservation/reservation-engine";
import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { assertSameOrigin } from "../../../../../lib/auth-http";
import { database } from "../../../../../lib/database";
import { GUEST_COOKIE, reservationErrorResponse } from "../../../../../lib/reservation-http";

const bodySchema = z.object({ expectedVersion: z.number().int().positive(),customerName:z.string().trim().min(1).max(100),customerPhone:z.string().trim().min(6).max(30),customerLocale:z.enum(["ko","zh-TW"]),termsVersion:z.string().min(1).max(50),privacyVersion:z.string().min(1).max(50),accepted:z.literal(true) });
export async function POST(request: NextRequest, route: { params: Promise<{ reservationId: string }> }): Promise<NextResponse> {
  const originError = assertSameOrigin(request); if (originError) return originError;
  try {
    const reservationId = z.string().uuid().parse((await route.params).reservationId);
    const ownerScope = request.cookies.get(GUEST_COOKIE)?.value;
    const body = bodySchema.safeParse(await request.json());
    if (!ownerScope || !body.success) return NextResponse.json({ error: { code: "INVALID_INPUT", message: "HOLD 정보를 확인해주세요." } }, { status: 400 });
    return NextResponse.json(await submitHold({ pool: database, reservationId, ownerScope, expectedVersion: body.data.expectedVersion,customerName:body.data.customerName,customerPhone:body.data.customerPhone,customerLocale:body.data.customerLocale,termsVersion:body.data.termsVersion,privacyVersion:body.data.privacyVersion }));
  } catch (error) { return reservationErrorResponse(error); }
}
