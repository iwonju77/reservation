export { writeAuditLog, type AuditEntry } from "./audit";
export { AuthError, type AuthErrorCode } from "./errors";
export { hashPassword, verifyPassword } from "./password";
export {
  authorizeRestaurant,
  createMemberAccount,
  deactivateUser,
  loginWithPassword,
  logout,
} from "./service";
export { createSessionToken, verifySessionToken } from "./token";
export type { AuthenticatedUser, AuthorizedContext, Membership, RestaurantRole } from "./types";
