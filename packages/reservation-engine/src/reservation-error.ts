export type ReservationErrorCode = "INVALID_REQUEST" | "NOT_AVAILABLE" | "HOLD_EXPIRED" | "FORBIDDEN" | "IDEMPOTENCY_CONFLICT" | "RATE_LIMITED" | "POLICY_NOT_FOUND" | "VERSION_CONFLICT";
export class ReservationError extends Error {
  constructor(public readonly code: ReservationErrorCode, message: string, public readonly details?: unknown) {
    super(message); this.name = "ReservationError";
  }
}
