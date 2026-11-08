import { FakePaymentProvider, processPaymentWebhook } from "@reservation/payments";
import { NextResponse, type NextRequest } from "next/server";
import { database } from "../../../../../lib/database";

export async function POST(request: NextRequest) {
  if (process.env.NODE_ENV === "production") return new NextResponse(null, { status: 404 });
  try { const body = await request.text(); return NextResponse.json(await processPaymentWebhook({ pool: database, provider: new FakePaymentProvider(), body, signature: request.headers.get("x-payment-signature") ?? "" })); }
  catch (error) { return NextResponse.json({ error: { message: error instanceof Error ? error.message : "webhook failed" } }, { status: 400 }); }
}
