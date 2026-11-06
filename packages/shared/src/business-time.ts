export interface Clock {
  now(): Date;
}

export const systemClock: Clock = { now: () => new Date() };

export function fixedClock(instant: Date): Clock {
  const fixed = new Date(instant);
  return { now: () => new Date(fixed) };
}

export function businessDateAt(instant: Date, timeZone: string, rolloverHour = 0): string {
  if (!Number.isInteger(rolloverHour) || rolloverHour < 0 || rolloverHour > 23) {
    throw new RangeError("rolloverHour must be an integer from 0 through 23");
  }

  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    hourCycle: "h23",
  }).formatToParts(instant);
  const value = (type: Intl.DateTimeFormatPartTypes): string => {
    const part = parts.find((candidate) => candidate.type === type)?.value;
    if (!part) throw new Error(`Missing ${type} in formatted date`);
    return part;
  };
  const year = Number(value("year"));
  const month = Number(value("month"));
  const day = Number(value("day"));
  const hour = Number(value("hour"));
  const localDate = new Date(Date.UTC(year, month - 1, day));
  if (hour < rolloverHour) localDate.setUTCDate(localDate.getUTCDate() - 1);
  return localDate.toISOString().slice(0, 10);
}

export function closingDayOffset(opensAt: string, closesAt: string): 0 | 1 {
  const minutes = (value: string): number => {
    const match = /^(?:[01]\d|2[0-3]):[0-5]\d$/.exec(value);
    if (!match) throw new RangeError(`Invalid local time: ${value}`);
    const [hour, minute] = value.split(":").map(Number) as [number, number];
    return hour * 60 + minute;
  };
  return minutes(closesAt) <= minutes(opensAt) ? 1 : 0;
}
