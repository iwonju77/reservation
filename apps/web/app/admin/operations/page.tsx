import { AuthError, authorizeRestaurant } from "@reservation/auth";
import { sessionSecret } from "@reservation/shared";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { z } from "zod";
import { SESSION_COOKIE } from "../../../lib/auth-http";
import { database } from "../../../lib/database";
import { OperationsDashboard } from "./operations-dashboard";

export default async function OperationsPage({ searchParams }: { searchParams: Promise<{ restaurantId?: string }> }) {
  const validRestaurant = z.string().uuid().safeParse((await searchParams).restaurantId);
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!validRestaurant.success || !token) redirect("/login");
  try {
    await authorizeRestaurant({ pool: database, token, secret: sessionSecret(), restaurantId: validRestaurant.data, minimumRole: "MANAGER" });
    return <OperationsDashboard restaurantId={validRestaurant.data} />;
  } catch (error) {
    if (error instanceof AuthError) redirect(`/admin?restaurantId=${validRestaurant.data}`);
    throw error;
  }
}
