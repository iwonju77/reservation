import { AuthError, authorizeRestaurant } from "@reservation/auth";
import { sessionSecret } from "@reservation/shared";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { z } from "zod";
import { SESSION_COOKIE } from "../../lib/auth-http";
import { database } from "../../lib/database";
import { LogoutButton } from "./logout-button";

export default async function AdminPage({
  searchParams,
}: {
  searchParams: Promise<{ restaurantId?: string }>;
}) {
  const { restaurantId } = await searchParams;
  const validRestaurant = z.string().uuid().safeParse(restaurantId);
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!validRestaurant.success || !token) redirect("/login");

  try {
    const user = await authorizeRestaurant({
      pool: database,
      token,
      secret: sessionSecret(),
      restaurantId: validRestaurant.data,
      minimumRole: "STAFF",
    });
    return (
      <main>
        <p className="eyebrow">서울아저씨 예약 시스템</p>
        <h1>{user.displayName}님</h1>
        <p>로그인과 매장 권한 확인이 완료되었습니다.</p>
        <dl>
          <dt>매장</dt><dd>{user.restaurantId}</dd>
          <dt>역할</dt><dd>{user.role}</dd>
        </dl>
        <LogoutButton />
      </main>
    );
  } catch (error) {
    if (error instanceof AuthError) redirect("/login");
    throw error;
  }
}
