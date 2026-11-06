import { describe, expect, it } from "vitest";
import { businessDateAt, closingDayOffset, fixedClock } from "./business-time.js";

describe("business time", () => {
  it("keeps after-midnight service on the previous Taipei business date", () => {
    const instant = new Date("2026-11-06T17:30:00.000Z"); // 2026-11-07 01:30 in Taipei
    expect(businessDateAt(instant, "Asia/Taipei", 4)).toBe("2026-11-06");
  });

  it("uses the new date after the rollover hour", () => {
    const instant = new Date("2026-11-06T20:30:00.000Z"); // 2026-11-07 04:30 in Taipei
    expect(businessDateAt(instant, "Asia/Taipei", 4)).toBe("2026-11-07");
  });

  it("identifies an overnight closing time", () => {
    expect(closingDayOffset("22:00", "02:00")).toBe(1);
    expect(closingDayOffset("11:30", "14:30")).toBe(0);
  });

  it("returns defensive date copies from a fixed clock", () => {
    const clock = fixedClock(new Date("2026-11-06T00:00:00.000Z"));
    const first = clock.now();
    first.setUTCFullYear(2000);
    expect(clock.now().toISOString()).toBe("2026-11-06T00:00:00.000Z");
  });
});
