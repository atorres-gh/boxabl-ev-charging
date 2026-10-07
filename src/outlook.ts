/**
 * Two-way Outlook sync for F1 Charge Station room (cs1@boxabl.com).
 *
 * App → Outlook: create/update/delete events (policy format: subject = full name,
 * location = F1 - Charge Station, no Teams).
 * Outlook → App: cron calendarView reconcile (every 5 min) — preferred over
 * Graph webhooks (harder on Workers without a public stable notify URL + renewal).
 *
 * OUTLOOK_SYNC=stub|graph. Best-effort: failures log, never block reservations.
 */
import type { Env } from "./env";
import { fetchGraphToken } from "./graph";
import {
  getPolicyAck,
  getReservation,
  intervalsOverlap,
  isCompletePolicyAck,
  listAllReservations,
  listPolicyAcks,
  listReservationsForDay,
  newReservationId,
  putReservation,
  type Reservation,
} from "./store";
import {
  addCalendarDays,
  minutesToHm,
  todayYmd,
  type Ymd,
} from "./time";
import { findAvailableSpot } from "./eligibility";
import { stationName, timezone } from "./env";

const APP_MARKER_PREFIX = "EV-APP:";

export type OutlookSyncMode = "stub" | "graph";

export interface OutlookEventLite {
  id: string;
  iCalUId?: string;
  subject: string;
  location?: string;
  start: { dateTime: string; timeZone?: string };
  end: { dateTime: string; timeZone?: string };
  isCancelled?: boolean;
  bodyPreview?: string;
  organizerEmail?: string;
  attendeeEmails?: string[];
}

export interface OutlookSync {
  mode: OutlookSyncMode;
  upsertForReservation(
    r: Reservation,
    displayName: string
  ): Promise<{ eventId?: string; iCalUId?: string; preview?: boolean }>;
  deleteForReservation(r: Reservation): Promise<{ preview?: boolean }>;
  listRoomEvents(fromYmd: Ymd, toYmd: Ymd): Promise<OutlookEventLite[]>;
}

export function outlookSyncMode(env: Env): OutlookSyncMode {
  const m = (env.OUTLOOK_SYNC || "stub").toLowerCase();
  return m === "graph" ? "graph" : "stub";
}

export function roomEmail(env: Env): string {
  return (env.OUTLOOK_ROOM_EMAIL || "cs1@boxabl.com").trim().toLowerCase();
}

export function roomDisplayName(env: Env): string {
  return env.OUTLOOK_ROOM_NAME || "F1 - Charge Station";
}

export function createOutlookSync(env: Env): OutlookSync {
  if (outlookSyncMode(env) === "graph") return new GraphOutlookSync(env);
  return new StubOutlookSync(env);
}

/** Prefer policy printed name; else Title Case from email local-part. */
export async function displayNameForEmail(env: Env, email: string): Promise<string> {
  const ack = await getPolicyAck(env, email);
  const printed = (ack?.printedName || "").trim();
  if (printed) return printed;
  return nameFromEmailLocal(email);
}

export function nameFromEmailLocal(email: string): string {
  const local = (email.split("@")[0] || email).trim();
  if (!local) return "Employee";
  return local
    .split(/[._+\-]+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join(" ");
}

function wallDateTime(ymd: Ymd, minutesFromMidnight: number): string {
  const hm = minutesToHm(minutesFromMidnight);
  return `${ymd}T${hm}:00`;
}

function parseGraphLocalDateTime(
  dateTime: string,
  timeZone: string,
  fallbackTz: string
): { ymd: Ymd; startMin: number } | null {
  // Graph returns "2026-10-08T09:00:00.0000000" (no Z) with timeZone field,
  // or ISO with Z. Prefer wall-clock parse of the dateTime string.
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})/.exec(dateTime);
  if (m) {
    return {
      ymd: m[1],
      startMin: Number(m[2]) * 60 + Number(m[3]),
    };
  }
  try {
    const d = new Date(dateTime);
    if (Number.isNaN(d.getTime())) return null;
    const tz = timeZone || fallbackTz;
    const fmt = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    });
    const map: Record<string, string> = {};
    for (const p of fmt.formatToParts(d)) {
      if (p.type !== "literal") map[p.type] = p.value;
    }
    return {
      ymd: `${map.year}-${map.month}-${map.day}`,
      startMin: Number(map.hour) * 60 + Number(map.minute),
    };
  } catch {
    return null;
  }
}

class StubOutlookSync implements OutlookSync {
  mode: OutlookSyncMode = "stub";
  constructor(private env: Env) {}

  async upsertForReservation(
    r: Reservation,
    displayName: string
  ): Promise<{ eventId?: string; iCalUId?: string; preview?: boolean }> {
    const eventId = r.outlookEventId || `stub-${r.id}`;
    const loc = roomDisplayName(this.env);
    console.log(
      "[outlook:stub] upsert\n" +
        `  room: ${roomEmail(this.env)} (${loc})\n` +
        `  subject: ${displayName}\n` +
        `  location: ${loc}\n` +
        `  start: ${r.date} ${minutesToHm(r.startMin)} PT\n` +
        `  end: ${r.date} ${minutesToHm(r.endMin)} PT\n` +
        `  reservationId: ${r.id}\n` +
        `  eventId: ${eventId}\n` +
        `  teams: none`
    );
    return { eventId, iCalUId: `stub-ical-${r.id}`, preview: true };
  }

  async deleteForReservation(r: Reservation): Promise<{ preview?: boolean }> {
    const eventId = r.outlookEventId || `stub-${r.id}`;
    console.log(
      `[outlook:stub] delete eventId=${eventId} reservationId=${r.id} room=${roomEmail(this.env)}`
    );
    return { preview: true };
  }

  async listRoomEvents(_fromYmd: Ymd, _toYmd: Ymd): Promise<OutlookEventLite[]> {
    console.log(
      `[outlook:stub] listRoomEvents — no remote events (OUTLOOK_SYNC=stub). room=${roomEmail(this.env)}`
    );
    return [];
  }
}

class GraphOutlookSync implements OutlookSync {
  mode: OutlookSyncMode = "graph";
  constructor(private env: Env) {}

  private async token(): Promise<string | null> {
    const tenant = this.env.GRAPH_TENANT_ID;
    const clientId = this.env.GRAPH_CLIENT_ID;
    const clientSecret = this.env.GRAPH_CLIENT_SECRET;
    if (!tenant || !clientId || !clientSecret) {
      console.warn("[outlook:graph] secrets missing — falling back to stub behavior for this call");
      return null;
    }
    return fetchGraphToken(tenant, clientId, clientSecret);
  }

  async upsertForReservation(
    r: Reservation,
    displayName: string
  ): Promise<{ eventId?: string; iCalUId?: string; preview?: boolean }> {
    const token = await this.token();
    if (!token) {
      return new StubOutlookSync(this.env).upsertForReservation(r, displayName);
    }
    const tz = timezone(this.env);
    const loc = roomDisplayName(this.env);
    const room = roomEmail(this.env);
    const body = {
      subject: displayName,
      body: {
        contentType: "Text",
        content: `${APP_MARKER_PREFIX}${r.id}\nBOXABL EV charging reservation\n${r.email}`,
      },
      start: { dateTime: wallDateTime(r.date, r.startMin), timeZone: tz },
      end: { dateTime: wallDateTime(r.date, r.endMin), timeZone: tz },
      location: { displayName: loc },
      isOnlineMeeting: false,
      allowNewTimeProposals: false,
      showAs: "busy",
    };

    const headers = {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    };

    try {
      if (r.outlookEventId && !r.outlookEventId.startsWith("stub-")) {
        const patchUrl = `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(room)}/events/${encodeURIComponent(r.outlookEventId)}`;
        const res = await fetch(patchUrl, {
          method: "PATCH",
          headers,
          body: JSON.stringify(body),
        });
        if (res.ok) {
          const data = (await res.json()) as { id?: string; iCalUId?: string };
          return { eventId: data.id || r.outlookEventId, iCalUId: data.iCalUId || r.iCalUId };
        }
        const detail = await res.text().catch(() => "");
        console.warn(
          `[outlook:graph] PATCH failed (${res.status}), will try create: ${detail.slice(0, 200)}`
        );
      }

      const createUrl = `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(room)}/events`;
      const res = await fetch(createUrl, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const detail = await res.text().catch(() => "");
        console.error(`[outlook:graph] create failed (${res.status}): ${detail.slice(0, 300)}`);
        return {};
      }
      const data = (await res.json()) as { id?: string; iCalUId?: string };
      console.log(
        `[outlook:graph] created event ${data.id} subject="${displayName}" ${r.date} ${minutesToHm(r.startMin)}–${minutesToHm(r.endMin)}`
      );
      return { eventId: data.id, iCalUId: data.iCalUId };
    } catch (err) {
      console.error("[outlook:graph] upsert error", err);
      return {};
    }
  }

  async deleteForReservation(r: Reservation): Promise<{ preview?: boolean }> {
    if (!r.outlookEventId || r.outlookEventId.startsWith("stub-")) {
      return new StubOutlookSync(this.env).deleteForReservation(r);
    }
    const token = await this.token();
    if (!token) {
      return new StubOutlookSync(this.env).deleteForReservation(r);
    }
    const room = roomEmail(this.env);
    try {
      const url = `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(room)}/events/${encodeURIComponent(r.outlookEventId)}`;
      const res = await fetch(url, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok && res.status !== 404) {
        const detail = await res.text().catch(() => "");
        console.error(`[outlook:graph] delete failed (${res.status}): ${detail.slice(0, 200)}`);
        return {};
      }
      console.log(`[outlook:graph] deleted event ${r.outlookEventId}`);
      return {};
    } catch (err) {
      console.error("[outlook:graph] delete error", err);
      return {};
    }
  }

  async listRoomEvents(fromYmd: Ymd, toYmd: Ymd): Promise<OutlookEventLite[]> {
    const token = await this.token();
    if (!token) {
      return new StubOutlookSync(this.env).listRoomEvents(fromYmd, toYmd);
    }
    const tz = timezone(this.env);
    const room = roomEmail(this.env);
    const start = `${fromYmd}T00:00:00`;
    const end = `${toYmd}T23:59:59`;
    const select =
      "id,iCalUId,subject,location,start,end,isCancelled,bodyPreview,organizer,attendees";
    let url =
      `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(room)}/calendarView` +
      `?startDateTime=${encodeURIComponent(start)}` +
      `&endDateTime=${encodeURIComponent(end)}` +
      `&$select=${encodeURIComponent(select)}` +
      `&$top=100` +
      `&$orderby=start/dateTime`;

    const out: OutlookEventLite[] = [];
    try {
      while (url) {
        const res = await fetch(url, {
          headers: {
            Authorization: `Bearer ${token}`,
            Prefer: `outlook.timezone="${tz}"`,
          },
        });
        if (!res.ok) {
          const detail = await res.text().catch(() => "");
          console.error(`[outlook:graph] calendarView failed (${res.status}): ${detail.slice(0, 300)}`);
          break;
        }
        const data = (await res.json()) as {
          value?: Array<Record<string, unknown>>;
          "@odata.nextLink"?: string;
        };
        for (const ev of data.value || []) {
          const organizer = ev.organizer as
            | { emailAddress?: { address?: string } }
            | undefined;
          const attendees = (ev.attendees as Array<{
            emailAddress?: { address?: string };
            type?: string;
          }> | undefined) || [];
          const loc = ev.location as { displayName?: string } | undefined;
          const startObj = ev.start as { dateTime?: string; timeZone?: string };
          const endObj = ev.end as { dateTime?: string; timeZone?: string };
          out.push({
            id: String(ev.id || ""),
            iCalUId: ev.iCalUId ? String(ev.iCalUId) : undefined,
            subject: String(ev.subject || "").trim(),
            location: loc?.displayName,
            start: {
              dateTime: String(startObj?.dateTime || ""),
              timeZone: startObj?.timeZone,
            },
            end: {
              dateTime: String(endObj?.dateTime || ""),
              timeZone: endObj?.timeZone,
            },
            isCancelled: !!ev.isCancelled,
            bodyPreview: ev.bodyPreview ? String(ev.bodyPreview) : undefined,
            organizerEmail: organizer?.emailAddress?.address?.toLowerCase(),
            attendeeEmails: attendees
              .map((a) => a.emailAddress?.address?.toLowerCase())
              .filter((e): e is string => !!e),
          });
        }
        url = data["@odata.nextLink"] || "";
      }
    } catch (err) {
      console.error("[outlook:graph] listRoomEvents error", err);
    }
    return out;
  }
}

/** Link outlook event id → reservation id in KV for fast lookup. */
export async function indexOutlookEvent(
  env: Env,
  eventId: string,
  reservationId: string
): Promise<void> {
  if (!eventId) return;
  await env.EV_STORE.put(`outlook:eid:${eventId}`, reservationId);
}

export async function lookupByOutlookEventId(
  env: Env,
  eventId: string
): Promise<Reservation | null> {
  if (!eventId) return null;
  const id = await env.EV_STORE.get(`outlook:eid:${eventId}`);
  if (!id) return null;
  return getReservation(env, id);
}

export async function clearOutlookIndex(env: Env, eventId: string | undefined): Promise<void> {
  if (!eventId) return;
  await env.EV_STORE.delete(`outlook:eid:${eventId}`);
}

/**
 * App → Outlook push after create/update. Best-effort; saves event id on success.
 */
export async function pushReservationToOutlook(env: Env, r: Reservation): Promise<void> {
  if (r.source === "outlook") {
    // Imported from Outlook — do not create a duplicate event.
    return;
  }
  try {
    const sync = createOutlookSync(env);
    const name = r.displayName?.trim() || (await displayNameForEmail(env, r.email));
    const result = await sync.upsertForReservation(r, name);
    if (result.eventId) {
      r.outlookEventId = result.eventId;
      if (result.iCalUId) r.iCalUId = result.iCalUId;
      r.source = r.source || "app";
      r.updatedAt = new Date().toISOString();
      await putReservation(env, r);
      await indexOutlookEvent(env, result.eventId, r.id);
    }
  } catch (err) {
    console.error("[outlook] push failed", err);
  }
}

/** Cancel/delete Outlook event after cancel/done/release. Best-effort. */
export async function deleteOutlookForReservation(env: Env, r: Reservation): Promise<void> {
  try {
    const sync = createOutlookSync(env);
    await sync.deleteForReservation(r);
    if (r.outlookEventId) {
      await clearOutlookIndex(env, r.outlookEventId);
    }
  } catch (err) {
    console.error("[outlook] delete failed", err);
  }
}

function extractAppMarker(bodyPreview?: string): string | null {
  if (!bodyPreview) return null;
  const m = new RegExp(`${APP_MARKER_PREFIX}([a-zA-Z0-9_-]+)`).exec(bodyPreview);
  return m ? m[1] : null;
}

function domainAllowed(email: string, allowed: string): boolean {
  const d = allowed.replace(/^\./, "").toLowerCase();
  return email.toLowerCase().endsWith("@" + d);
}

/**
 * Resolve a @boxabl.com email from Outlook event (organizer / attendees / subject→ack match).
 */
export async function resolvePersonFromOutlookEvent(
  env: Env,
  ev: OutlookEventLite
): Promise<{
  email: string | null;
  displayName: string;
  unknown: boolean;
}> {
  const domain = (env.ALLOWED_EMAIL_DOMAIN || "boxabl.com").toLowerCase();
  const room = roomEmail(env);
  const candidates: string[] = [];
  if (ev.organizerEmail && ev.organizerEmail !== room) candidates.push(ev.organizerEmail);
  for (const a of ev.attendeeEmails || []) {
    if (a !== room) candidates.push(a);
  }
  for (const c of candidates) {
    if (domainAllowed(c, domain)) {
      const ack = await getPolicyAck(env, c);
      const displayName =
        (ack?.printedName || "").trim() || ev.subject.trim() || nameFromEmailLocal(c);
      return { email: c.toLowerCase(), displayName, unknown: false };
    }
  }

  // Match subject to a known policy printed name.
  const subject = ev.subject.trim().toLowerCase();
  if (subject) {
    const acks = await listPolicyAcks(env);
    const hit = acks.find((a) => (a.printedName || "").trim().toLowerCase() === subject);
    if (hit) {
      return {
        email: hit.email,
        displayName: hit.printedName.trim() || ev.subject.trim(),
        unknown: false,
      };
    }
  }

  const displayName = ev.subject.trim() || "Outlook booking";
  return { email: null, displayName, unknown: true };
}

/**
 * Outlook → App reconcile via calendarView (today … +14 days).
 * Imports busy blocks; flags needsPolicyAck when no complete ack.
 */
export async function pullOutlookIntoApp(env: Env): Promise<{
  imported: number;
  updated: number;
  cancelled: number;
  flagged: number;
}> {
  const stats = { imported: 0, updated: 0, cancelled: 0, flagged: 0 };
  const tz = timezone(env);
  const today = todayYmd(tz);
  const to = addCalendarDays(today, 14);
  const sync = createOutlookSync(env);
  const events = await sync.listRoomEvents(today, to);
  const seenIds = new Set<string>();

  for (const ev of events) {
    if (!ev.id || ev.isCancelled) continue;
    seenIds.add(ev.id);

    const startP = parseGraphLocalDateTime(ev.start.dateTime, ev.start.timeZone || tz, tz);
    const endP = parseGraphLocalDateTime(ev.end.dateTime, ev.end.timeZone || tz, tz);
    if (!startP || !endP) continue;
    if (startP.ymd !== endP.ymd) {
      // Overnight — rare; skip or clamp (policy is same-day).
      console.warn(`[outlook] skip multi-day event ${ev.id}`);
      continue;
    }
    const date = startP.ymd;
    const startMin = startP.startMin;
    const endMin = endP.startMin;
    if (endMin <= startMin) continue;

    // Already linked by our app marker?
    const markerId = extractAppMarker(ev.bodyPreview);
    if (markerId) {
      const existing = await getReservation(env, markerId);
      if (existing) {
        await indexOutlookEvent(env, ev.id, existing.id);
        if (!existing.outlookEventId) {
          existing.outlookEventId = ev.id;
          if (ev.iCalUId) existing.iCalUId = ev.iCalUId;
          existing.updatedAt = new Date().toISOString();
          await putReservation(env, existing);
        }
        continue;
      }
    }

    let linked = await lookupByOutlookEventId(env, ev.id);
    if (!linked && ev.iCalUId) {
      // Slow path: scan recent reservations for iCalUId (MVP).
      const all = await listAllReservations(env, 500);
      linked = all.find((r) => r.iCalUId === ev.iCalUId) || null;
      if (linked) await indexOutlookEvent(env, ev.id, linked.id);
    }

    if (linked) {
      // Update times if Outlook changed them.
      if (
        linked.date !== date ||
        linked.startMin !== startMin ||
        linked.endMin !== endMin
      ) {
        // Check conflict excluding self.
        const spot = await findAvailableSpot(env, date, startMin, endMin, linked.id);
        if (spot != null || (linked.date === date && linked.spot)) {
          linked.date = date;
          linked.startMin = startMin;
          linked.endMin = endMin;
          if (spot != null) linked.spot = spot;
          linked.updatedAt = new Date().toISOString();
          await putReservation(env, linked);
          stats.updated++;
        }
      }
      // Refresh needsPolicyAck if still unsigned.
      if (linked.email && !linked.email.startsWith("outlook-unknown@")) {
        const ack = await getPolicyAck(env, linked.email);
        const need = !isCompletePolicyAck(ack);
        if (need && !linked.needsPolicyAck) {
          linked.needsPolicyAck = true;
          linked.updatedAt = new Date().toISOString();
          await putReservation(env, linked);
          stats.flagged++;
        } else if (!need && linked.needsPolicyAck) {
          linked.needsPolicyAck = false;
          linked.updatedAt = new Date().toISOString();
          await putReservation(env, linked);
        }
      }
      continue;
    }

    // New Outlook-origin event → import as busy block.
    const person = await resolvePersonFromOutlookEvent(env, ev);
    const email =
      person.email ||
      `outlook-unknown+${ev.id.slice(0, 12).replace(/[^a-zA-Z0-9]/g, "")}@imported.local`;

    let needsPolicyAck = true;
    let unknownPerson = person.unknown;
    if (person.email) {
      const ack = await getPolicyAck(env, person.email);
      needsPolicyAck = !isCompletePolicyAck(ack);
    }

    // Spot: try find free; if conflict with app booking, still import as spot 1 notes conflict
    // but prefer blocking — if no spot, skip import and log.
    let spot = await findAvailableSpot(env, date, startMin, endMin);
    if (spot == null) {
      // Overlaps existing — if the overlap is already an app booking for same window, skip.
      const day = await listReservationsForDay(env, date);
      const overlap = day.filter(
        (r) =>
          (r.status === "booked" || r.status === "admin_override") &&
          intervalsOverlap(startMin, endMin, r.startMin, r.endMin)
      );
      if (overlap.length) {
        console.log(
          `[outlook] skip import ${ev.id} — overlaps ${overlap.map((o) => o.id).join(",")}`
        );
        continue;
      }
      spot = 1;
    }

    const nowIso = new Date().toISOString();
    const r: Reservation = {
      id: newReservationId(),
      email,
      displayName: person.displayName,
      station: stationName(env),
      spot,
      date,
      startMin,
      endMin,
      status: "booked",
      createdAt: nowIso,
      updatedAt: nowIso,
      source: "outlook",
      outlookEventId: ev.id,
      iCalUId: ev.iCalUId,
      needsPolicyAck,
      unknownPerson,
      notes: unknownPerson
        ? `Imported from Outlook (unknown person). Subject: ${ev.subject}`
        : `Imported from Outlook. Subject: ${ev.subject}`,
    };
    await putReservation(env, r);
    await indexOutlookEvent(env, ev.id, r.id);
    stats.imported++;
    if (needsPolicyAck) stats.flagged++;
    console.log(
      `[outlook] imported ${r.id} ${date} ${minutesToHm(startMin)}–${minutesToHm(endMin)} ` +
        `name="${person.displayName}" email=${email} needsPolicyAck=${needsPolicyAck}`
    );
  }

  // Cancel app reservations (outlook-sourced or any with outlookEventId) that vanished from the window.
  const windowRes = await listAllReservations(env, 500);
  for (const r of windowRes) {
    if (r.status !== "booked" && r.status !== "admin_override") continue;
    if (!r.outlookEventId) continue;
    if (r.outlookEventId.startsWith("stub-")) continue;
    if (r.date < today || r.date > to) continue;
    if (seenIds.has(r.outlookEventId)) continue;
    // Event gone from room calendar → cancel in app.
    const nowIso = new Date().toISOString();
    r.status = "cancelled";
    r.cancelledAt = nowIso;
    r.updatedAt = nowIso;
    r.companyCancel = true;
    r.notes = [r.notes, "Cancelled — removed from Outlook room calendar"]
      .filter(Boolean)
      .join(" · ");
    await putReservation(env, r);
    await clearOutlookIndex(env, r.outlookEventId);
    stats.cancelled++;
    console.log(`[outlook] cancelled ${r.id} — event ${r.outlookEventId} missing from calendarView`);
  }

  console.log(
    `[outlook] pull done imported=${stats.imported} updated=${stats.updated} cancelled=${stats.cancelled} flagged=${stats.flagged}`
  );
  return stats;
}

/** Clear needsPolicyAck on all active reservations for this email once they sign. */
export async function clearNeedsPolicyAckForEmail(env: Env, email: string): Promise<void> {
  const list = await listAllReservations(env, 500);
  const e = email.toLowerCase();
  const nowIso = new Date().toISOString();
  for (const r of list) {
    if (r.email.toLowerCase() !== e) continue;
    if (!r.needsPolicyAck) continue;
    r.needsPolicyAck = false;
    r.updatedAt = nowIso;
    await putReservation(env, r);
  }
}
