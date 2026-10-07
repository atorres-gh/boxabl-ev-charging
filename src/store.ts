import type { Env } from "./env";
import { seedAdminEmails } from "./env";
import { randomId } from "./crypto";
import type { Ymd } from "./time";

export type ReservationStatus =
  | "booked"
  | "cancelled"
  | "completed"
  | "released"
  | "admin_override";

export interface Reservation {
  id: string;
  email: string;
  /** Display name for day board / Outlook subject (printedName or Outlook subject). */
  displayName?: string;
  station: string;
  spot: number;
  date: Ymd;
  startMin: number;
  endMin: number;
  status: ReservationStatus;
  createdAt: string;
  updatedAt: string;
  cancelledAt?: string;
  completedAt?: string;
  releasedAt?: string;
  /** True when created/extended by admin override tools. */
  override?: boolean;
  notes?: string;
  /** Session canceled by company/admin — does not consume charging day. */
  companyCancel?: boolean;
  /** Graph calendar event id on the room mailbox (cs1). */
  outlookEventId?: string;
  /** Graph iCalUId for dedupe across sync. */
  iCalUId?: string;
  /** Who created the booking: app UI or imported from Outlook. */
  source?: "app" | "outlook";
  /**
   * Outlook-only (or any) booking where the person has no complete policy ack yet.
   * Cleared when they complete name + signature in the app.
   */
  needsPolicyAck?: boolean;
  /** Could not map Outlook organizer/attendees to a @boxabl.com user. */
  unknownPerson?: boolean;
}

export interface PolicyAck {
  email: string;
  acknowledgedAt: string;
  policyVersion: string;
  /** Legal printed name at acknowledgment time. */
  printedName: string;
  /**
   * Drawn signature as PNG data URL for in-app signs.
   * Empty for admin external overrides (paper / SharePoint / old process).
   */
  signatureDataUrl: string;
  /** How the ack was recorded. Default / omit = in-app pad. */
  source?: "app" | "admin_external";
  /** Where the external signed copy lives (note or link). */
  externalNote?: string;
  /** Admin who recorded an external override. */
  overriddenBy?: string;
  overriddenAt?: string;
}

export interface UserFlags {
  email: string;
  /** Contractor one-time / ongoing exception (admin-flagged). */
  contractorException?: boolean;
  /** Overnight / weekend charging allowed (admin-flagged). */
  hoursException?: boolean;
  /** Cadence / 3-hour exceptions. */
  cadenceException?: boolean;
  notes?: string;
  updatedAt: string;
  updatedBy: string;
}

export const POLICY_VERSION = "2026-onsite-ev-v3";

export function activeStatuses(): ReservationStatus[] {
  return ["booked", "admin_override"];
}

export function consumesChargingDay(r: Reservation): boolean {
  if (r.status === "cancelled" && r.companyCancel) return false;
  if (r.status === "cancelled") {
    // User cancel before use — do not consume (MVP fairness).
    return false;
  }
  if (r.status === "released" && r.companyCancel) return false;
  // Booked, completed, admin_override, released-after-use consume the day.
  return (
    r.status === "booked" ||
    r.status === "completed" ||
    r.status === "admin_override" ||
    r.status === "released"
  );
}

export async function getPolicyAck(env: Env, email: string): Promise<PolicyAck | null> {
  return (await env.EV_STORE.get(`ack:${email.toLowerCase()}`, "json")) as PolicyAck | null;
}

/** True when ack is usable for reserving (in-app name+sig, or admin external override with printed name). */
export function isCompletePolicyAck(ack: PolicyAck | null | undefined): boolean {
  if (!ack) return false;
  const name = (ack.printedName || "").trim();
  if (!name) return false;
  if (ack.source === "admin_external") return true;
  const sig = (ack.signatureDataUrl || "").trim();
  return sig.startsWith("data:image/");
}

/** True when ack has a drawable in-app signature (for stamped PDF download/email). */
export function hasInAppSignature(ack: PolicyAck | null | undefined): boolean {
  if (!ack) return false;
  if (ack.source === "admin_external") return false;
  return (ack.signatureDataUrl || "").trim().startsWith("data:image/");
}

export async function putPolicyAck(
  env: Env,
  email: string,
  printedName: string,
  signatureDataUrl: string
): Promise<PolicyAck> {
  const ack: PolicyAck = {
    email: email.toLowerCase(),
    acknowledgedAt: new Date().toISOString(),
    policyVersion: POLICY_VERSION,
    printedName: printedName.trim(),
    signatureDataUrl: signatureDataUrl.trim(),
    source: "app",
  };
  await env.EV_STORE.put(`ack:${ack.email}`, JSON.stringify(ack));
  return ack;
}

/** Admin records that the employee already signed outside this app (paper / SharePoint / etc.). */
export async function putExternalPolicyAck(
  env: Env,
  input: {
    email: string;
    printedName: string;
    adminEmail: string;
    externalNote?: string;
    /** ISO or YYYY-MM-DD; defaults to now. */
    acknowledgedAt?: string;
  }
): Promise<PolicyAck> {
  const email = input.email.toLowerCase();
  let acknowledgedAt = new Date().toISOString();
  if (input.acknowledgedAt) {
    const raw = input.acknowledgedAt.trim();
    if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
      // Noon PT-ish as UTC+7 offset approximation: store as date-only noon UTC for stable display.
      acknowledgedAt = `${raw}T12:00:00.000Z`;
    } else {
      const d = new Date(raw);
      if (!Number.isNaN(d.getTime())) acknowledgedAt = d.toISOString();
    }
  }
  const nowIso = new Date().toISOString();
  const note = (input.externalNote || "").trim();
  const ack: PolicyAck = {
    email,
    acknowledgedAt,
    policyVersion: POLICY_VERSION,
    printedName: input.printedName.trim(),
    signatureDataUrl: "",
    source: "admin_external",
    externalNote: note || undefined,
    overriddenBy: input.adminEmail.toLowerCase(),
    overriddenAt: nowIso,
  };
  await env.EV_STORE.put(`ack:${email}`, JSON.stringify(ack));
  return ack;
}

export async function deletePolicyAck(env: Env, email: string): Promise<boolean> {
  const key = `ack:${email.toLowerCase()}`;
  const existing = await env.EV_STORE.get(key);
  if (existing == null) return false;
  await env.EV_STORE.delete(key);
  return true;
}

export async function listPolicyAcks(env: Env): Promise<PolicyAck[]> {
  const listed = await env.EV_STORE.list({ prefix: "ack:" });
  const out: PolicyAck[] = [];
  for (const key of listed.keys) {
    const v = (await env.EV_STORE.get(key.name, "json")) as PolicyAck | null;
    if (v) out.push(v);
  }
  out.sort((a, b) => a.acknowledgedAt.localeCompare(b.acknowledgedAt));
  return out;
}

export async function getUserFlags(env: Env, email: string): Promise<UserFlags | null> {
  return (await env.EV_STORE.get(`flags:${email.toLowerCase()}`, "json")) as UserFlags | null;
}

export async function putUserFlags(env: Env, flags: UserFlags): Promise<UserFlags> {
  const email = flags.email.toLowerCase();
  const next = { ...flags, email };
  await env.EV_STORE.put(`flags:${email}`, JSON.stringify(next));
  return next;
}

export async function getReservation(env: Env, id: string): Promise<Reservation | null> {
  return (await env.EV_STORE.get(`res:${id}`, "json")) as Reservation | null;
}

export async function putReservation(env: Env, r: Reservation): Promise<void> {
  await env.EV_STORE.put(`res:${r.id}`, JSON.stringify(r));
  const dayKey = `day:${r.date}`;
  const dayList = ((await env.EV_STORE.get(dayKey, "json")) as string[] | null) || [];
  if (!dayList.includes(r.id)) {
    dayList.push(r.id);
    await env.EV_STORE.put(dayKey, JSON.stringify(dayList));
  }
  const userKey = `userres:${r.email.toLowerCase()}`;
  const ulist = ((await env.EV_STORE.get(userKey, "json")) as string[] | null) || [];
  if (!ulist.includes(r.id)) {
    ulist.push(r.id);
    await env.EV_STORE.put(userKey, JSON.stringify(ulist));
  }
}

export async function listReservationsForDay(env: Env, date: Ymd): Promise<Reservation[]> {
  const ids = ((await env.EV_STORE.get(`day:${date}`, "json")) as string[] | null) || [];
  const out: Reservation[] = [];
  for (const id of ids) {
    const r = await getReservation(env, id);
    if (r) out.push(r);
  }
  out.sort((a, b) => a.startMin - b.startMin || a.createdAt.localeCompare(b.createdAt));
  return out;
}

export async function listReservationsForUser(env: Env, email: string): Promise<Reservation[]> {
  const ids = ((await env.EV_STORE.get(`userres:${email.toLowerCase()}`, "json")) as string[] | null) || [];
  const out: Reservation[] = [];
  for (const id of ids) {
    const r = await getReservation(env, id);
    if (r) out.push(r);
  }
  out.sort((a, b) => b.date.localeCompare(a.date) || b.startMin - a.startMin);
  return out;
}

export async function listAllReservations(env: Env, limit = 200): Promise<Reservation[]> {
  const listed = await env.EV_STORE.list({ prefix: "res:" });
  const out: Reservation[] = [];
  for (const key of listed.keys.slice(0, limit)) {
    const v = (await env.EV_STORE.get(key.name, "json")) as Reservation | null;
    if (v) out.push(v);
  }
  out.sort((a, b) => b.date.localeCompare(a.date) || a.startMin - b.startMin);
  return out;
}

export function newReservationId(): string {
  return randomId(12);
}

/** True if two half-open intervals [aStart,aEnd) and [bStart,bEnd) overlap. */
export function intervalsOverlap(
  aStart: number,
  aEnd: number,
  bStart: number,
  bEnd: number
): boolean {
  return aStart < bEnd && bStart < aEnd;
}

/** KV key for admins added via the Admin UI (merged with env ADMIN_EMAILS seed). */
const EXTRA_ADMINS_KEY = "admins:extra";

export async function getExtraAdmins(env: Env): Promise<string[]> {
  const list = (await env.EV_STORE.get(EXTRA_ADMINS_KEY, "json")) as string[] | null;
  if (!Array.isArray(list)) return [];
  return [
    ...new Set(
      list
        .map((e) => String(e || "").trim().toLowerCase())
        .filter(Boolean)
    ),
  ].sort();
}

async function putExtraAdmins(env: Env, emails: string[]): Promise<string[]> {
  const cleaned = [
    ...new Set(
      emails
        .map((e) => String(e || "").trim().toLowerCase())
        .filter(Boolean)
    ),
  ].sort();
  await env.EV_STORE.put(EXTRA_ADMINS_KEY, JSON.stringify(cleaned));
  return cleaned;
}

/** True when email is in env ADMIN_EMAILS seed or KV extras. */
export async function isAdmin(env: Env, email: string): Promise<boolean> {
  const e = email.trim().toLowerCase();
  if (!e) return false;
  if (seedAdminEmails(env).has(e)) return true;
  const extras = await getExtraAdmins(env);
  return extras.includes(e);
}

export async function listAdmins(env: Env): Promise<{
  seed: string[];
  extra: string[];
  all: string[];
}> {
  const seed = [...seedAdminEmails(env)].sort();
  const extra = await getExtraAdmins(env);
  const all = [...new Set([...seed, ...extra])].sort();
  return { seed, extra, all };
}

export async function addExtraAdmin(
  env: Env,
  email: string
): Promise<{ ok: true; extra: string[] } | { ok: false; error: string }> {
  const e = email.trim().toLowerCase();
  if (!e) return { ok: false, error: "Enter an email." };
  const seed = seedAdminEmails(env);
  if (seed.has(e)) {
    return { ok: false, error: "That address is already a built-in admin." };
  }
  const extras = await getExtraAdmins(env);
  if (extras.includes(e)) {
    return { ok: false, error: "That address is already on the admin list." };
  }
  const next = await putExtraAdmins(env, [...extras, e]);
  return { ok: true, extra: next };
}

export async function removeExtraAdmin(
  env: Env,
  email: string
): Promise<{ ok: true; extra: string[] } | { ok: false; error: string }> {
  const e = email.trim().toLowerCase();
  if (!e) return { ok: false, error: "Enter an email." };
  if (seedAdminEmails(env).has(e)) {
    return {
      ok: false,
      error: "Built-in admin — change ADMIN_EMAILS in Cloudflare if you need to remove them.",
    };
  }
  const extras = await getExtraAdmins(env);
  if (!extras.includes(e)) {
    return { ok: false, error: "That address is not on the added-admin list." };
  }
  const next = await putExtraAdmins(
    env,
    extras.filter((x) => x !== e)
  );
  return { ok: true, extra: next };
}
