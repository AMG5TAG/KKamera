// Trial countdown copy. New trials last 24 hours, so time left is shown in
// hours (or minutes near the end); older 14-day trials still read in days.

const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

export interface TimeLeft {
  /** Milliseconds until the trial ends, never negative. */
  ms: number;
  /** Rounded-up count in `unit`, at least 1 while time remains. */
  value: number;
  unit: "minute" | "hour" | "day";
  /** e.g. "23 hours", "1 minute", "3 days". */
  label: string;
}

export function trialTimeLeft(trialEnd: Date | string, now: number = Date.now()): TimeLeft {
  const ms = Math.max(0, new Date(trialEnd).getTime() - now);
  const [value, unit]: [number, TimeLeft["unit"]] =
    ms < HOUR_MS ? [Math.max(ms > 0 ? 1 : 0, Math.ceil(ms / MINUTE_MS)), "minute"] :
    ms < 2 * DAY_MS ? [Math.ceil(ms / HOUR_MS), "hour"] :
    [Math.ceil(ms / DAY_MS), "day"];
  return { ms, value, unit, label: `${value} ${unit}${value === 1 ? "" : "s"}` };
}
