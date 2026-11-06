export type BusinessPeriodInput = {
  weekday: number;
  opensAt: string;
  closesAt: string;
  closesDayOffset: 0 | 1;
};

export type PolicyRuleInput = {
  ruleType:
    | "BOOKING_WINDOW" | "PARTY_LIMIT" | "DURATION" | "CLEANUP" | "START_INTERVAL"
    | "APPROVAL" | "MINIMUM_SPEND" | "DEPOSIT" | "CANCELLATION" | "WAITLIST" | "NO_SHOW";
  priority?: number | undefined;
  weekdays?: number[] | undefined;
  localStart?: string | undefined;
  localEnd?: string | undefined;
  minPartySize?: number | undefined;
  maxPartySize?: number | undefined;
  durationMinutes?: number | undefined;
  amountMinor?: number | undefined;
  value?: Record<string, unknown> | undefined;
};
