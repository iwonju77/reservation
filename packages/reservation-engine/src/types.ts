export type EvaluatedPolicy = {
  policyVersionId: string;
  durationMinutes: number;
  cleanupMinutes: number;
  startIntervalMinutes: number;
  minimumSpendMinor: number;
  depositMinor: number;
  requiresApproval: boolean;
  opensDaysAhead: number;
  cutoffMinutes: number;
};
export type HoldRequest = {
  pool: import("@reservation/db").DatabasePool;
  restaurantId: string;
  ownerScope: string;
  idempotencyKey: string;
  businessDate: string;
  startsAt: Date;
  partySize: number;
  seatCount?: number | undefined;
  now?: Date | undefined;
};
