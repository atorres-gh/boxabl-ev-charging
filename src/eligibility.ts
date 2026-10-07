import type { Env } from "./env";
import {
  bookAheadDays,
  closeHour,
  graceMinutes,
  maxSessionHours,
  openHour,
  spotCount,
  stationName,
  timezone,
} from "./env";
import {
  activeStatuses,
  consumesChargingDay,
  getUserFlags,
  intervalsOverlap,
  listReservationsForDay,
  listReservationsForUser,
  type Reservation,
  type UserFlags,
} from "./store";
import {
  addCalendarDays,
  calendarDaysBetween,
  compareYmd,
  isBusinessDayYmd,
  isWeekendYmd,
  minutesToHm,
  nextEligibleChargingDay,
  todayYmd,
  weekdayLabel,
  zonedDateTimeToUtcMs,
  type Ymd,
} from "./time";

export interface EligibilityResult {
  ok: boolean;
  errors: string[];
  warnings: string[];
  date: Ymd;
  weekday: string;
  isBusinessDay: boolean;
  nextEligibleAfterLast?: Ymd | null;
  lastChargingDay?: Ymd | null;
  openHm: string;
  closeHm: string;
  maxHours: number;
  bookAheadDays: number;
  spotCount: number;
  station: string;
  flags: UserFlags | null;
}

export async function lastConsumingDay(
  env: Env,
  email: string,
  beforeOrOn?: Ymd
): Promise<Ymd | null> {
  const list = await listReservationsForUser(env, email);
  let last: Ymd | null = null;
  for (const r of list) {
    if (!consumesChargingDay(r)) continue;
    if (beforeOrOn && compareYmd(r.date, beforeOrOn) > 0) continue;
    if (!last || compareYmd(r.date, last) > 0) last = r.date;
  }
  return last;
}

export async function evaluateEligibility(
  env: Env,
  email: string,
  date: Ymd,
  startMin: number | null,
  endMin: number | null,
  opts?: { adminOverride?: boolean; skipCadence?: boolean }
): Promise<EligibilityResult> {
  const tz = timezone(env);
  const open = openHour(env) * 60;
  const close = closeHour(env) * 60;
  const maxH = maxSessionHours(env);
  const ahead = bookAheadDays(env);
  const flags = await getUserFlags(env, email);
  const errors: string[] = [];
  const warnings: string[] = [];
  const today = todayYmd(tz);
  const business = isBusinessDayYmd(date, tz);
  const weekend = isWeekendYmd(date, tz);

  const last = await lastConsumingDay(env, email);
  let nextEligible: Ymd | null = null;
  if (last) nextEligible = nextEligibleChargingDay(last, tz);

  if (!opts?.adminOverride) {
    if (compareYmd(date, today) < 0) {
      errors.push("You cannot book a date in the past.");
    }
    const daysAhead = calendarDaysBetween(today, date);
    if (daysAhead > ahead) {
      errors.push(`You can book at most ${ahead} days ahead.`);
    }

    if (weekend || !business) {
      if (!flags?.hoursException) {
        errors.push("Weekend charging needs an admin exception. Station hours are Mon–Fri only.");
      }
    }

    if (!opts?.skipCadence && !flags?.cadenceException) {
      // One session per charging day
      const dayRes = await listReservationsForUser(env, email);
      const sameDay = dayRes.filter((r) => r.date === date && consumesChargingDay(r));
      if (sameDay.length > 0) {
        errors.push("You already have a charging session on that day. One session per charging day.");
      }

      if (last && nextEligible) {
        if (compareYmd(date, nextEligible) < 0 && date !== last) {
          errors.push(
            `Every other business day: after charging on ${last} (${weekdayLabel(last, tz)}), next eligible is ${nextEligible} (${weekdayLabel(nextEligible, tz)}).`
          );
        }
        // Also block the immediate next business day explicitly when date is between last and nextEligible
      }
    }

    if (startMin != null && endMin != null) {
      if (endMin <= startMin) errors.push("End time must be after start time.");
      const durationH = (endMin - startMin) / 60;
      if (durationH > maxH + 1e-9 && !flags?.cadenceException) {
        errors.push(`Sessions are limited to ${maxH} hours.`);
      }
      if (startMin < open || endMin > close) {
        if (!flags?.hoursException) {
          errors.push(
            `Sessions must start and end between ${minutesToHm(open)} and ${minutesToHm(close)} (${tz}).`
          );
        }
      }
    }
  }

  return {
    ok: errors.length === 0,
    errors,
    warnings,
    date,
    weekday: weekdayLabel(date, tz),
    isBusinessDay: business,
    nextEligibleAfterLast: nextEligible,
    lastChargingDay: last,
    openHm: minutesToHm(open),
    closeHm: minutesToHm(close),
    maxHours: maxH,
    bookAheadDays: ahead,
    spotCount: spotCount(env),
    station: stationName(env),
    flags,
  };
}

export async function findAvailableSpot(
  env: Env,
  date: Ymd,
  startMin: number,
  endMin: number,
  excludeId?: string
): Promise<number | null> {
  const spots = spotCount(env);
  const day = await listReservationsForDay(env, date);
  const active = day.filter(
    (r) => activeStatuses().includes(r.status) && r.id !== excludeId
  );
  for (let spot = 1; spot <= spots; spot++) {
    const conflict = active.some(
      (r) => r.spot === spot && intervalsOverlap(startMin, endMin, r.startMin, r.endMin)
    );
    if (!conflict) return spot;
  }
  return null;
}

export function isReleasable(env: Env, r: Reservation, now = new Date()): boolean {
  if (!activeStatuses().includes(r.status)) return false;
  const tz = timezone(env);
  const startMs = zonedDateTimeToUtcMs(r.date, r.startMin, tz);
  const graceMs = graceMinutes(env) * 60_000;
  return now.getTime() >= startMs + graceMs;
}

export function enrichReservation(env: Env, r: Reservation, now = new Date()) {
  return {
    ...r,
    startHm: minutesToHm(r.startMin),
    endHm: minutesToHm(r.endMin),
    releasable: isReleasable(env, r, now),
    weekday: weekdayLabel(r.date, timezone(env)),
  };
}

export function suggestBookableDates(env: Env, count = 5): Ymd[] {
  const tz = timezone(env);
  const today = todayYmd(tz);
  const ahead = bookAheadDays(env);
  const out: Ymd[] = [];
  for (let i = 0; i <= ahead; i++) {
    const d = addCalendarDays(today, i);
    if (isBusinessDayYmd(d, tz)) out.push(d);
  }
  return out.slice(0, count);
}
