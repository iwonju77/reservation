export type OperationsErrorCode =
  | "INVALID_CONFIGURATION"
  | "NOT_FOUND"
  | "IMPACT_CONFIRMATION_REQUIRED"
  | "POLICY_CONFLICT";

export class OperationsError extends Error {
  constructor(public readonly code: OperationsErrorCode, message: string, public readonly details?: unknown) {
    super(message);
    this.name = "OperationsError";
  }
}
