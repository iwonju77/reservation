import { createPaymentSession, FakePaymentProvider } from "@reservation/payments";
import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { assertSameOrigin } from "../../../../../lib/auth-http";
import { database } from "../../../../../lib/database";

export async function POST(request: NextRequest, route: { params: Promise<{ reservationId: string }> }) {
  const origin = assertSameOrigin(request); if (origin) return origin;
  if (process.env.NODE_ENV === "production") return NextResponse.json({ error: { message: "결제 제공업체가 아직 설정되지 않았습니다." } }, { status: 503 });
  try {
    const reservationId = z.string().uuid().parse((await route.params).reservationId);
    const authorization = request.headers.get("authorization");
    if (!authorization?.startsWith("Bearer ")) throw new Error("management token is required");
    const idempotencyKey = request.headers.get("idempotency-key");
    if (!idempotencyKey || idempotencyKey.length > 200) throw new Error("idempotency key is required");
    return NextResponse.json(await createPaymentSession({ pool: database, provider: new FakePaymentProvider(), reservationId, managementToken: authorization.slice(7), idempotencyKey }));
  } catch (error) { return NextResponse.json({ error: { message: error instanceof Error ? error.message : "payment session failed" } }, { status: 400 }); }
}
