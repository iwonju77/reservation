import { randomUUID } from "node:crypto";
import { jwtVerify, SignJWT } from "jose";

const ISSUER = "seoul-uncle-reservation";
const AUDIENCE = "reservation-staff";

export async function createSessionToken(input: {
  sessionId: string;
  userId: string;
  expiresAt: Date;
  secret: Uint8Array;
}): Promise<string> {
  return new SignJWT({ sid: input.sessionId })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setSubject(input.userId)
    .setJti(randomUUID())
    .setIssuedAt()
    .setExpirationTime(Math.floor(input.expiresAt.getTime() / 1_000))
    .sign(input.secret);
}

export async function verifySessionToken(
  token: string,
  secret: Uint8Array,
): Promise<{ sessionId: string; userId: string }> {
  const verified = await jwtVerify(token, secret, {
    issuer: ISSUER,
    audience: AUDIENCE,
    algorithms: ["HS256"],
  });
  const sessionId = verified.payload.sid;
  const userId = verified.payload.sub;
  if (typeof sessionId !== "string" || typeof userId !== "string") {
    throw new Error("Invalid session payload");
  }
  return { sessionId, userId };
}
