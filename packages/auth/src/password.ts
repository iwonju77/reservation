import { compare, hash } from "bcryptjs";

const PASSWORD_COST = 12;
const DUMMY_PASSWORD_HASH = "$2a$10$N9qo8uLOickgx2ZMRZoMyeIjZAgcfl7p92ldGxad68LJZdL17lhWy";

export async function hashPassword(password: string): Promise<string> {
  if (password.length < 12 || password.length > 128) {
    throw new RangeError("Password must be between 12 and 128 characters");
  }
  return hash(password, PASSWORD_COST);
}

export async function verifyPassword(password: string, passwordHash?: string): Promise<boolean> {
  return compare(password, passwordHash ?? DUMMY_PASSWORD_HASH);
}
