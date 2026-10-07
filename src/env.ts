/** Worker bindings + vars. Secrets via wrangler secret / .dev.vars — never invent real values. */
export interface Env {
  EV_STORE: KVNamespace;
  ASSETS: Fetcher;

  ALLOWED_EMAIL_DOMAIN: string;
  OTP_TTL_SECONDS: string;
  SESSION_TTL_SECONDS: string;
  COOKIE_NAME: string;
  MAIL_PROVIDER: string;
  MAIL_FROM: string;
  MAIL_SUBJECT: string;

  STATION_NAME: string;
  SPOT_COUNT: string;
  MAX_SESSION_HOURS: string;
  BOOK_AHEAD_DAYS: string;
  GRACE_MINUTES: string;
  OPEN_HOUR: string;
  CLOSE_HOUR: string;
  TIMEZONE: string;
  ADMIN_EMAILS: string;

  /** Required in every environment. */
  SESSION_SECRET: string;

  /** Microsoft Graph (MAIL_PROVIDER=graph). */
  GRAPH_TENANT_ID?: string;
  GRAPH_CLIENT_ID?: string;
  GRAPH_CLIENT_SECRET?: string;
  GRAPH_SENDER?: string;

  /** Outlook room calendar sync (OUTLOOK_SYNC=stub|graph). */
  OUTLOOK_SYNC?: string;
  OUTLOOK_ROOM_EMAIL?: string;
  OUTLOOK_ROOM_NAME?: string;

  SMTP_HOST?: string;
  SMTP_USER?: string;
  SMTP_PASS?: string;
  SMTP_FROM?: string;
}

export function num(envValue: string | undefined, fallback: number): number {
  const n = Number(envValue);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export function stationName(env: Env): string {
  return env.STATION_NAME || "F1 Charge Station";
}

export function spotCount(env: Env): number {
  return Math.max(1, Math.floor(num(env.SPOT_COUNT, 1)));
}

export function maxSessionHours(env: Env): number {
  return num(env.MAX_SESSION_HOURS, 3);
}

export function bookAheadDays(env: Env): number {
  return Math.floor(num(env.BOOK_AHEAD_DAYS, 2));
}

export function graceMinutes(env: Env): number {
  return Math.floor(num(env.GRACE_MINUTES, 15));
}

export function openHour(env: Env): number {
  return Math.floor(num(env.OPEN_HOUR, 6));
}

export function closeHour(env: Env): number {
  return Math.floor(num(env.CLOSE_HOUR, 18));
}

export function timezone(env: Env): string {
  return env.TIMEZONE || "America/Los_Angeles";
}

/** Built-in admins from Cloudflare ADMIN_EMAILS (always admin; not removable in UI). */
export function seedAdminEmails(env: Env): Set<string> {
  const raw = env.ADMIN_EMAILS || "";
  return new Set(
    raw
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean)
  );
}

/** @deprecated Prefer seedAdminEmails; kept as alias for seed list. */
export function adminEmails(env: Env): Set<string> {
  return seedAdminEmails(env);
}

/** Sync seed-only check. Prefer async isAdmin from store.ts (seed ∪ KV extras). */
export function isSeedAdmin(env: Env, email: string): boolean {
  return seedAdminEmails(env).has(email.trim().toLowerCase());
}
