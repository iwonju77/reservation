import { ReservationError } from "@reservation/reservation-engine";
import { NextResponse } from "next/server";

export const GUEST_COOKIE = "reservation_guest";
export function reservationErrorResponse(error: unknown): NextResponse {
  if (error instanceof ReservationError) {
    const status = error.code === "NOT_AVAILABLE" || error.code === "VERSION_CONFLICT" || error.code === "IDEMPOTENCY_CONFLICT" ? 409
      : error.code === "FORBIDDEN" ? 403 : error.code === "RATE_LIMITED" ? 429 : error.code === "POLICY_NOT_FOUND" ? 422 : error.code === "HOLD_EXPIRED" ? 410 : 400;
    return NextResponse.json({ error: { code: error.code, message: error.message, details: error.details } }, { status });
  }
  console.error(JSON.stringify({ level: "error", event: "reservation.request_failed" }));
  return NextResponse.json({ error: { code: "INTERNAL_ERROR", message: "예약 요청을 처리하지 못했습니다." } }, { status: 500 });
}
