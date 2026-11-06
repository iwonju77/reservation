"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";

export default function LoginPage() {
  const router = useRouter();
  const [message, setMessage] = useState<string>();
  const [pending, setPending] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setMessage(undefined);
    const form = new FormData(event.currentTarget);
    const response = await fetch("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: form.get("email"), password: form.get("password") }),
    });
    const result = await response.json() as {
      user?: { memberships: Array<{ restaurantId: string }> };
      error?: { message: string };
    };
    if (!response.ok || !result.user) {
      setMessage(result.error?.message ?? "로그인하지 못했습니다.");
      setPending(false);
      return;
    }
    const restaurantId = result.user.memberships[0]?.restaurantId;
    router.push(restaurantId ? `/admin?restaurantId=${restaurantId}` : "/");
  }

  return (
    <main>
      <p className="eyebrow">서울아저씨 예약 시스템</p>
      <h1>직원 로그인</h1>
      <form onSubmit={submit} className="login-form">
        <label htmlFor="email">이메일</label>
        <input id="email" name="email" type="email" autoComplete="username" required />
        <label htmlFor="password">비밀번호</label>
        <input id="password" name="password" type="password" autoComplete="current-password" required />
        {message ? <p role="alert">{message}</p> : null}
        <button type="submit" disabled={pending}>{pending ? "확인 중…" : "로그인"}</button>
      </form>
    </main>
  );
}
