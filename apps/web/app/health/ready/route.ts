import { checkDatabase } from "@reservation/db";

export async function GET() {
  try {
    await checkDatabase();
    return Response.json({ status: "ready", dependencies: { database: "ready" } });
  } catch {
    return Response.json(
      { status: "not_ready", dependencies: { database: "unavailable" } },
      { status: 503 },
    );
  }
}
