import { AuthError } from "@reservation/auth";
import {
  createDiningTable,
  createPolicyDraft,
  createReservationBlock,
  createTableCombination,
  getOperationsConfiguration,
  OperationsError,
  previewPolicy,
  publishPolicy,
  replaceBusinessHours,
  setSpecialBusinessDate,
  updateDiningTable,
  updateTableCombination,
} from "@reservation/operations";
import { sessionSecret } from "@reservation/shared";
import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { assertSameOrigin, authErrorResponse, SESSION_COOKIE } from "../../../../../../lib/auth-http";
import { database } from "../../../../../../lib/database";

const time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
const period = z.object({ weekday: z.number().int().min(0).max(6), opensAt: time, closesAt: time, closesDayOffset: z.union([z.literal(0), z.literal(1)]) });
const specialPeriod = period.omit({ weekday: true });
const policyRule = z.object({
  ruleType: z.enum(["BOOKING_WINDOW", "PARTY_LIMIT", "DURATION", "CLEANUP", "START_INTERVAL", "APPROVAL", "MINIMUM_SPEND", "DEPOSIT", "CANCELLATION", "WAITLIST", "NO_SHOW"]),
  priority: z.number().int().optional(), weekdays: z.array(z.number().int().min(0).max(6)).optional(),
  localStart: time.optional(), localEnd: time.optional(), minPartySize: z.number().int().positive().optional(),
  maxPartySize: z.number().int().positive().optional(), durationMinutes: z.number().int().positive().optional(),
  amountMinor: z.number().int().nonnegative().optional(), value: z.record(z.string(), z.unknown()).optional(),
});
const command = z.discriminatedUnion("action", [
  z.object({ action: z.literal("CREATE_TABLE"), name: z.string().trim().min(1).max(100), defaultSeats: z.number().int().positive(), maxSeats: z.number().int().positive(), zone: z.string().max(100).optional(), notes: z.string().max(1000).optional() }),
  z.object({ action: z.literal("UPDATE_TABLE"), tableId: z.string().uuid(), name: z.string().trim().min(1).max(100), defaultSeats: z.number().int().positive(), maxSeats: z.number().int().positive(), active: z.boolean(), confirmImpact: z.boolean().optional() }),
  z.object({ action: z.literal("CREATE_COMBINATION"), name: z.string().trim().min(1).max(100), tableIds: z.array(z.string().uuid()).min(2), maxSeats: z.number().int().positive() }),
  z.object({ action: z.literal("UPDATE_COMBINATION"), combinationId: z.string().uuid(), name: z.string().trim().min(1).max(100), tableIds: z.array(z.string().uuid()).min(2), maxSeats: z.number().int().positive(), active: z.boolean() }),
  z.object({ action: z.literal("REPLACE_HOURS"), periods: z.array(period).max(50) }),
  z.object({ action: z.literal("SET_SPECIAL_DATE"), businessDate: z.string().date(), kind: z.enum(["CLOSED", "SPECIAL_OPEN"]), reason: z.string().max(500).optional(), periods: z.array(specialPeriod).max(10).optional() }),
  z.object({ action: z.literal("CREATE_BLOCK"), tableId: z.string().uuid().optional(), startsAt: z.string().datetime(), endsAt: z.string().datetime(), reason: z.string().trim().min(1).max(500) }),
  z.object({ action: z.literal("CREATE_POLICY_DRAFT"), name: z.string().trim().min(1).max(100), description: z.string().max(1000).optional(), rules: z.array(policyRule).min(4).max(100) }),
  z.object({ action: z.literal("PUBLISH_POLICY"), policyId: z.string().uuid(), validFrom: z.string().date(), validUntil: z.string().date().optional() }),
  z.object({ action: z.literal("PREVIEW_POLICY"), policyId: z.string().uuid(), weekday: z.number().int().min(0).max(6), localTime: time, partySize: z.number().int().positive() }),
]);

function operationsError(error: unknown): NextResponse {
  if (error instanceof AuthError) return authErrorResponse(error);
  if (error instanceof OperationsError) {
    const status = error.code === "NOT_FOUND" ? 404 : error.code === "IMPACT_CONFIRMATION_REQUIRED" || error.code === "POLICY_CONFLICT" ? 409 : 400;
    return NextResponse.json({ error: { code: error.code, message: error.message, details: error.details } }, { status });
  }
  return authErrorResponse(error);
}

async function contextFor(request: NextRequest, route: { params: Promise<{ restaurantId: string }> }) {
  const token = request.cookies.get(SESSION_COOKIE)?.value;
  if (!token) throw new AuthError("UNAUTHENTICATED", "Session cookie is missing");
  const restaurantId = z.string().uuid().parse((await route.params).restaurantId);
  return { pool: database, actorToken: token, secret: sessionSecret(), restaurantId };
}

export async function GET(request: NextRequest, route: { params: Promise<{ restaurantId: string }> }): Promise<NextResponse> {
  try { return NextResponse.json(await getOperationsConfiguration(await contextFor(request, route))); }
  catch (error) { return operationsError(error); }
}

export async function POST(request: NextRequest, route: { params: Promise<{ restaurantId: string }> }): Promise<NextResponse> {
  const originError = assertSameOrigin(request); if (originError) return originError;
  try {
    const input = command.safeParse(await request.json());
    if (!input.success) return NextResponse.json({ error: { code: "INVALID_INPUT", message: "운영 설정을 확인해주세요." } }, { status: 400 });
    const base = await contextFor(request, route); const value = input.data;
    switch (value.action) {
      case "CREATE_TABLE": return NextResponse.json(await createDiningTable({ ...base, ...value }), { status: 201 });
      case "UPDATE_TABLE": await updateDiningTable({ ...base, ...value }); break;
      case "CREATE_COMBINATION": return NextResponse.json(await createTableCombination({ ...base, ...value }), { status: 201 });
      case "UPDATE_COMBINATION": await updateTableCombination({ ...base, ...value }); break;
      case "REPLACE_HOURS": await replaceBusinessHours({ ...base, periods: value.periods }); break;
      case "SET_SPECIAL_DATE": return NextResponse.json(await setSpecialBusinessDate({ ...base, ...value }));
      case "CREATE_BLOCK": return NextResponse.json(await createReservationBlock({ ...base, ...value, startsAt: new Date(value.startsAt), endsAt: new Date(value.endsAt) }), { status: 201 });
      case "CREATE_POLICY_DRAFT": return NextResponse.json(await createPolicyDraft({ ...base, ...value }), { status: 201 });
      case "PUBLISH_POLICY": await publishPolicy({ ...base, ...value }); break;
      case "PREVIEW_POLICY": return NextResponse.json(await previewPolicy({ ...base, ...value }));
    }
    return NextResponse.json({ updated: true });
  } catch (error) { return operationsError(error); }
}
