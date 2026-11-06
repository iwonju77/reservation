"use client";

import { useCallback, useEffect, useState, type FormEvent } from "react";

type Configuration = {
  summary: { activeTableCount: number; activeDefaultSeats: number; activeMaxSeats: number };
  tables: Array<{ id: string; name: string; default_seats: number; max_seats: number; inactive_at: string | null }>;
  combinations: Array<{ id: string; name: string; max_seats: number; active: boolean; table_ids: string[] }>;
  businessHours: Array<{ id: string; weekday: number; opens_at: string; closes_at: string; closes_day_offset: number }>;
  specialDates: Array<{ id: string; business_date: string; kind: string; reason: string | null }>;
  policies: Array<{ id: string; version: number; status: string; name: string }>;
  blocks: Array<{ id: string; table_id: string | null; blocked_period: string; reason: string }>;
};

export function OperationsDashboard({ restaurantId }: { restaurantId: string }) {
  const [configuration, setConfiguration] = useState<Configuration>();
  const [message, setMessage] = useState("불러오는 중…");
  const endpoint = `/api/admin/restaurants/${restaurantId}/operations`;
  const load = useCallback(async () => {
    const response = await fetch(endpoint); const body = await response.json() as Configuration & { error?: { message?: string } };
    if (!response.ok) { setMessage(body.error?.message ?? "설정을 불러오지 못했습니다."); return; }
    setConfiguration(body); setMessage("");
  }, [endpoint]);
  useEffect(() => { void load(); }, [load]);

  async function send(command: Record<string, unknown>) {
    setMessage("저장 중…");
    const response = await fetch(endpoint, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(command) });
    const body = await response.json() as { error?: { message?: string } };
    if (!response.ok) { setMessage(body.error?.message ?? "저장하지 못했습니다."); return false; }
    setMessage("저장했습니다."); await load(); return true;
  }

  async function createTable(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); const form = new FormData(event.currentTarget);
    if (await send({ action: "CREATE_TABLE", name: form.get("name"), defaultSeats: Number(form.get("defaultSeats")), maxSeats: Number(form.get("maxSeats")), zone: form.get("zone") || undefined })) event.currentTarget.reset();
  }
  async function replaceHours(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); const form = new FormData(event.currentTarget);
    await send({ action: "REPLACE_HOURS", periods: [{ weekday: Number(form.get("weekday")), opensAt: form.get("opensAt"), closesAt: form.get("closesAt"), closesDayOffset: form.get("overnight") === "on" ? 1 : 0 }] });
  }
  async function specialDate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); const form = new FormData(event.currentTarget); const kind = String(form.get("kind"));
    await send({ action: "SET_SPECIAL_DATE", businessDate: form.get("businessDate"), kind, reason: form.get("reason") || undefined, periods: kind === "SPECIAL_OPEN" ? [{ opensAt: form.get("opensAt"), closesAt: form.get("closesAt"), closesDayOffset: 0 }] : [] });
  }
  async function createPolicy(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); const form = new FormData(event.currentTarget);
    await send({ action: "CREATE_POLICY_DRAFT", name: form.get("name"), rules: [
      { ruleType: "BOOKING_WINDOW", value: { opensDaysAhead: Number(form.get("opensDaysAhead")), cutoffMinutes: Number(form.get("cutoffMinutes")) } },
      { ruleType: "PARTY_LIMIT", minPartySize: 1, maxPartySize: Number(form.get("maxPartySize")) },
      { ruleType: "DURATION", durationMinutes: Number(form.get("durationMinutes")) },
      { ruleType: "START_INTERVAL", durationMinutes: Number(form.get("startInterval")) },
      { ruleType: "CLEANUP", durationMinutes: Number(form.get("cleanupMinutes")) },
      { ruleType: "APPROVAL", value: { required: form.get("approval") === "on" } },
      { ruleType: "DEPOSIT", amountMinor: Number(form.get("depositMinor")) },
    ] });
  }
  async function publishPolicy(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); const form = new FormData(event.currentTarget);
    await send({ action: "PUBLISH_POLICY", policyId: form.get("policyId"), validFrom: form.get("validFrom"), validUntil: form.get("validUntil") || undefined });
  }

  return <main className="operations-page">
    <p className="eyebrow">서울아저씨 예약 시스템</p><h1>운영 설정</h1>
    {message ? <p role="status">{message}</p> : null}
    {configuration ? <>
      <section><h2>현재 수용 규모</h2><p>활성 테이블 {configuration.summary.activeTableCount}개 · 기본 {configuration.summary.activeDefaultSeats}석 · 최대 {configuration.summary.activeMaxSeats}석</p></section>
      <section><h2>테이블</h2><ul>{configuration.tables.map((table) => <li key={table.id}>{table.name}: {table.default_seats}–{table.max_seats}석 {table.inactive_at ? "(비활성)" : ""}</li>)}</ul>
        <form onSubmit={createTable} className="settings-form"><input name="name" placeholder="테이블명" required /><input name="defaultSeats" type="number" min="1" placeholder="기본 좌석" required /><input name="maxSeats" type="number" min="1" placeholder="최대 좌석" required /><input name="zone" placeholder="구역" /><button>테이블 추가</button></form></section>
      <section><h2>주간 영업시간</h2><ul>{configuration.businessHours.map((hour) => <li key={hour.id}>요일 {hour.weekday}: {hour.opens_at}–{hour.closes_at}{hour.closes_day_offset ? " (익일)" : ""}</li>)}</ul>
        <p className="form-note">저장하면 기존 주간 시간표를 입력한 한 구간으로 교체합니다.</p><form onSubmit={replaceHours} className="settings-form"><select name="weekday">{["일","월","화","수","목","금","토"].map((day, value) => <option key={day} value={value}>{day}</option>)}</select><input name="opensAt" type="time" required /><input name="closesAt" type="time" required /><label><input name="overnight" type="checkbox" /> 익일 종료</label><button>시간표 교체</button></form></section>
      <section><h2>특별일</h2><ul>{configuration.specialDates.map((date) => <li key={date.id}>{date.business_date}: {date.kind} {date.reason}</li>)}</ul>
        <form onSubmit={specialDate} className="settings-form"><input name="businessDate" type="date" required /><select name="kind"><option value="CLOSED">임시휴무</option><option value="SPECIAL_OPEN">특별영업</option></select><input name="opensAt" type="time" defaultValue="17:00" /><input name="closesAt" type="time" defaultValue="21:00" /><input name="reason" placeholder="사유" /><button>특별일 저장</button></form></section>
      <section><h2>예약 정책</h2><ul>{configuration.policies.map((policy) => <li key={policy.id}>v{policy.version} {policy.name} — {policy.status}</li>)}</ul>
        <form onSubmit={createPolicy} className="settings-form"><input name="name" placeholder="정책명" required /><input name="opensDaysAhead" type="number" min="1" defaultValue="30" aria-label="예약 오픈 일수" /><input name="cutoffMinutes" type="number" min="0" defaultValue="120" aria-label="마감 분" /><input name="maxPartySize" type="number" min="1" defaultValue="12" aria-label="최대 인원" /><input name="durationMinutes" type="number" min="1" defaultValue="90" aria-label="이용 시간" /><input name="startInterval" type="number" min="1" defaultValue="30" aria-label="시작 간격" /><input name="cleanupMinutes" type="number" min="1" defaultValue="15" aria-label="정리 시간" /><input name="depositMinor" type="number" min="0" defaultValue="0" aria-label="예약금 최소 단위" /><label><input name="approval" type="checkbox" /> 직원 승인 필요</label><button>정책 초안 생성</button></form>
        <form onSubmit={publishPolicy} className="settings-form"><select name="policyId" required><option value="">게시할 초안</option>{configuration.policies.filter((policy) => policy.status === "DRAFT").map((policy) => <option key={policy.id} value={policy.id}>v{policy.version} {policy.name}</option>)}</select><input name="validFrom" type="date" required aria-label="적용 시작일" /><input name="validUntil" type="date" aria-label="적용 종료일" /><button>정책 게시</button></form></section>
    </> : null}
  </main>;
}
