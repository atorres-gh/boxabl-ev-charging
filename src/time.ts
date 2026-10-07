/** America/Los_Angeles helpers for charging windows (no overnight without exception). */

export type Ymd = string; // YYYY-MM-DD in station timezone

const DOW_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;

/** Parts of `instant` in the given IANA timezone. */
export function zonedParts(
  instant: Date,
  timeZone: string
): { y: number; m: number; d: number; hour: number; minute: number; dow: number } {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    weekday: "short",
  });
  const map: Record<string, string> = {};
  for (const p of fmt.formatToParts(instant)) {
    if (p.type !== "literal") map[p.type] = p.value;
  }
  const dowMap: Record<string, number> = {
    Sun: 0,
    Mon: 1,
    Tue: 2,
    Wed: 3,
    Thu: 4,
    Fri: 5,
    Sat: 6,
  };
  return {
    y: Number(map.year),
    m: Number(map.month),
    d: Number(map.day),
    hour: Number(map.hour),
    minute: Number(map.minute),
    dow: dowMap[map.weekday] ?? 0,
  };
}

export function formatYmd(y: number, m: number, d: number): Ymd {
  return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

export function todayYmd(timeZone: string, now = new Date()): Ymd {
  const p = zonedParts(now, timeZone);
  return formatYmd(p.y, p.m, p.d);
}

export function parseYmd(ymd: Ymd): { y: number; m: number; d: number } | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd);
  if (!m) return null;
  return { y: Number(m[1]), m: Number(m[2]), d: Number(m[3]) };
}

/** Day-of-week 0=Sun..6=Sat for a calendar YMD interpreted in the station zone (noon UTC proxy). */
export function dowForYmd(ymd: Ymd, timeZone: string): number {
  const p = parseYmd(ymd);
  if (!p) return -1;
  // Use noon UTC on that calendar date, then read weekday in zone — avoids DST edge for date-only.
  const approx = new Date(Date.UTC(p.y, p.m - 1, p.d, 20, 0, 0));
  return zonedParts(approx, timeZone).dow;
}

export function isWeekendYmd(ymd: Ymd, timeZone: string): boolean {
  const dow = dowForYmd(ymd, timeZone);
  return dow === 0 || dow === 6;
}

export function isBusinessDayYmd(ymd: Ymd, timeZone: string): boolean {
  return !isWeekendYmd(ymd, timeZone);
}

/** Add `n` calendar days to a YMD (n may be negative). */
export function addCalendarDays(ymd: Ymd, n: number): Ymd {
  const p = parseYmd(ymd);
  if (!p) throw new Error("Invalid date");
  const dt = new Date(Date.UTC(p.y, p.m - 1, p.d));
  dt.setUTCDate(dt.getUTCDate() + n);
  return formatYmd(dt.getUTCFullYear(), dt.getUTCMonth() + 1, dt.getUTCDate());
}

/** Next business day strictly after `ymd` (Mon–Fri only; holidays not modeled yet). */
export function nextBusinessDay(ymd: Ymd, timeZone: string): Ymd {
  let cur = addCalendarDays(ymd, 1);
  for (let i = 0; i < 14; i++) {
    if (isBusinessDayYmd(cur, timeZone)) return cur;
    cur = addCalendarDays(cur, 1);
  }
  return cur;
}

/**
 * Every-other-business-day: from a charging day, skip one business day.
 * Mon→Wed, Tue→Thu, Wed→Fri, Thu→Mon, Fri→Tue.
 */
export function nextEligibleChargingDay(fromYmd: Ymd, timeZone: string): Ymd {
  const first = nextBusinessDay(fromYmd, timeZone);
  return nextBusinessDay(first, timeZone);
}

/** Minutes from midnight for HH:MM (24h). */
export function parseHmToMinutes(hm: string): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hm.trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h < 0 || h > 23 || min < 0 || min > 59) return null;
  return h * 60 + min;
}

export function minutesToHm(total: number): string {
  const h = Math.floor(total / 60);
  const m = total % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

/**
 * Approximate epoch ms for `ymd` + minutes-from-midnight in `timeZone`.
 * Uses iterative offset correction (good enough for grace / overlap checks).
 */
export function zonedDateTimeToUtcMs(ymd: Ymd, minutesFromMidnight: number, timeZone: string): number {
  const p = parseYmd(ymd);
  if (!p) throw new Error("Invalid date");
  const hour = Math.floor(minutesFromMidnight / 60);
  const minute = minutesFromMidnight % 60;
  // Start with a UTC guess equal to wall clock, then adjust by observed offset.
  let guess = Date.UTC(p.y, p.m - 1, p.d, hour, minute, 0);
  for (let i = 0; i < 3; i++) {
    const parts = zonedParts(new Date(guess), timeZone);
    const asWanted = Date.UTC(p.y, p.m - 1, p.d, hour, minute, 0);
    const asObserved = Date.UTC(parts.y, parts.m - 1, parts.d, parts.hour, parts.minute, 0);
    const delta = asWanted - asObserved;
    guess += delta;
    if (delta === 0) break;
  }
  return guess;
}

export function compareYmd(a: Ymd, b: Ymd): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function calendarDaysBetween(a: Ymd, b: Ymd): number {
  const pa = parseYmd(a);
  const pb = parseYmd(b);
  if (!pa || !pb) return NaN;
  const da = Date.UTC(pa.y, pa.m - 1, pa.d);
  const db = Date.UTC(pb.y, pb.m - 1, pb.d);
  return Math.round((db - da) / 86_400_000);
}

export function weekdayLabel(ymd: Ymd, timeZone: string): string {
  const dow = dowForYmd(ymd, timeZone);
  return DOW_SHORT[dow] || "";
}
