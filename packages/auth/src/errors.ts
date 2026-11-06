export type AuthErrorCode =
  | "INVALID_CREDENTIALS"
  | "ACCOUNT_LOCKED"
  | "UNAUTHENTICATED"
  | "FORBIDDEN"
  | "MFA_REQUIRED"
  | "EMAIL_IN_USE";

export class AuthError extends Error {
  constructor(
    public readonly code: AuthErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "AuthError";
  }
}
