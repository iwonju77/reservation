import { getAvailability } from "@reservation/reservation-engine";
import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { database } from "../../../../../lib/database";
import { reservationErrorResponse } from "../../../../../lib/reservation-http";

const querySchema = z.object({ businessDate: z.string().date(), startsAt: z.string().datetime(), partySize: z.coerce.number().int().positive().max(100) });
export async function GET(request: NextRequest, route: { params: Promise<{ restaurantId: string }> }): Promise<NextResponse> {
  try {
    const restaurantId = z.string().uuid().parse((await route.params).restaurantId);
    const query = querySchema.safeParse(Object.fromEntries(request.nextUrl.searchParams));
    if (!query.success) return NextResponse.json({ error: { code: "INVALID_INPUT", message: "조회 조건을 확인해주세요." } }, { status: 400 });
    return NextResponse.json(await getAvailability({ pool: database, restaurantId, businessDate: query.data.businessDate, startsAt: new Date(query.data.startsAt), partySize: query.data.partySize }));
  } catch (error) { return reservationErrorResponse(error); }
}
