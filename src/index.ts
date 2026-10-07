import type { Env } from "./env";
import { adminEmails, isAdmin, stationName, timezone } from "./env";
import { createMailSender } from "./mail";
import { createSignedPolicyAttachment } from "./signed-policy-pdf";
import { assertAllowedEmail, issueOtp, normalizeEmail, verifyOtp } from "./otp";
import { createSession, destroySession, readSession } from "./session";
import {
  enrichReservation,
  evaluateEligibility,
  findAvailableSpot,
  isReleasable,
  suggestBookableDates,
} from "./eligibility";
import {
  getPolicyAck,
  getReservation,
  getUserFlags,
  isCompletePolicyAck,
  listAllReservations,
  listPolicyAcks,
  listReservationsForDay,
  listReservationsForUser,
  newReservationId,
  putPolicyAck,
  putReservation,
  putUserFlags,
  type Reservation,
} from "./store";
import { parseHmToMinutes, todayYmd } from "./time";

export default {
  async fetch(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    try {
      // ── Auth ──────────────────────────────────────────────
      if (path === "/api/auth/request" && request.method === "POST") {
        return await handleRequestCode(request, env);
      }
      if (path === "/api/auth/verify" && request.method === "POST") {
        return await handleVerify(request, env);
      }
      if (path === "/api/auth/logout" && (request.method === "POST" || request.method === "GET")) {
        return await handleLogout(request, env, url);
      }

      // ── Authenticated APIs ────────────────────────────────
      if (path.startsWith("/api/")) {
        const session = await readSession(env, request);
        if (!session) return json({ error: "Sign in required." }, 401);

        if (path === "/api/me" && request.method === "GET") {
          return handleMe(env, session.email);
        }
        if (path === "/api/config" && request.method === "GET") {
          return handleConfig(env, session.email);
        }
        if (path === "/api/policy-ack" && request.method === "GET") {
          const ack = await getPolicyAck(env, session.email);
          return json({ ok: true, ack });
        }
        if (path === "/api/policy-ack" && request.method === "POST") {
          return await handlePolicyAck(request, env, session.email);
        }
        if (path === "/api/eligibility" && request.method === "GET") {
          return await handleEligibility(url, env, session.email);
        }
        if (path === "/api/reservations" && request.method === "GET") {
          return await handleListMine(env, session.email);
        }
        if (path === "/api/reservations" && request.method === "POST") {
          return await handleCreate(request, env, session.email);
        }
        if (path === "/api/day" && request.method === "GET") {
          return await handleDayBoard(url, env);
        }

        const cancelMatch = /^\/api\/reservations\/([^/]+)\/cancel$/.exec(path);
        if (cancelMatch && request.method === "POST") {
          return await handleCancel(env, session.email, cancelMatch[1], false);
        }
        const doneMatch = /^\/api\/reservations\/([^/]+)\/done$/.exec(path);
        if (doneMatch && request.method === "POST") {
          return await handleDone(env, session.email, doneMatch[1]);
        }

        // ── Admin ───────────────────────────────────────────
        if (path.startsWith("/api/admin/")) {
          if (!isAdmin(env, session.email)) {
            return json({ error: "Admin access required." }, 403);
          }
          if (path === "/api/admin/reservations" && request.method === "GET") {
            return await handleAdminList(url, env);
          }
          if (path === "/api/admin/policy-acks" && request.method === "GET") {
            const acks = await listPolicyAcks(env);
            return json({ ok: true, acks });
          }
          const releaseMatch = /^\/api\/admin\/reservations\/([^/]+)\/release$/.exec(path);
          if (releaseMatch && request.method === "POST") {
            return await handleAdminRelease(env, session.email, releaseMatch[1]);
          }
          if (path === "/api/admin/override" && request.method === "POST") {
            return await handleAdminOverride(request, env, session.email);
          }
          if (path === "/api/admin/flags" && request.method === "GET") {
            const email = normalizeEmail(url.searchParams.get("email") || "");
            if (!email) return json({ error: "email query required." }, 400);
            const flags = await getUserFlags(env, email);
            return json({ ok: true, flags });
          }
          if (path === "/api/admin/flags" && request.method === "POST") {
            return await handleAdminFlags(request, env, session.email);
          }
          return json({ error: "Not found." }, 404);
        }

        return json({ error: "Not found." }, 404);
      }

      return await handlePage(request, env, path);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Server error.";
      console.error("[ev]", message);
      return json({ error: "Server error.", detail: message }, 500);
    }
  },
} satisfies ExportedHandler<Env>;

async function handleRequestCode(request: Request, env: Env): Promise<Response> {
  const body = await readJson(request);
  const email = normalizeEmail(String(body.email || ""));
  const domainErr = assertAllowedEmail(email, env.ALLOWED_EMAIL_DOMAIN);
  if (domainErr) {
    // Contractor exception path: allow if admin already flagged them.
    const flags = await getUserFlags(env, email);
    if (!flags?.contractorException) return json({ error: domainErr }, 400);
  }
  if (!env.SESSION_SECRET) {
    return json({ error: "Auth is not configured.", detail: "SESSION_SECRET missing." }, 500);
  }

  const { code } = await issueOtp(env, email);
  const mail = createMailSender(env);
  let preview = false;
  try {
    const result = await mail.sendOtp(email, code);
    preview = !!result.preview;
  } catch (err) {
    const detail = err instanceof Error ? err.message : "Mail send failed.";
    return json({ error: "Could not send a code.", detail }, 502);
  }

  const payload: Record<string, unknown> = { ok: true };
  if (preview || (env.MAIL_PROVIDER || "stub").toLowerCase() === "stub") {
    payload.previewCode = code;
  }
  return json(payload);
}

async function handleVerify(request: Request, env: Env): Promise<Response> {
  const body = await readJson(request);
  const email = normalizeEmail(String(body.email || ""));
  const code = String(body.code || "");
  const domainErr = assertAllowedEmail(email, env.ALLOWED_EMAIL_DOMAIN);
  if (domainErr) {
    const flags = await getUserFlags(env, email);
    if (!flags?.contractorException) return json({ error: domainErr }, 400);
  }
  if (!env.SESSION_SECRET) {
    return json({ error: "Auth is not configured.", detail: "SESSION_SECRET missing." }, 500);
  }

  const result = await verifyOtp(env, email, code);
  if (!result.ok) return json({ error: result.error }, 401);

  const secure = new URL(request.url).protocol === "https:";
  const { cookie } = await createSession(env, email, secure);
  return json({ ok: true, admin: isAdmin(env, email) }, 200, { "Set-Cookie": cookie });
}

async function handleLogout(request: Request, env: Env, url: URL): Promise<Response> {
  const clear = await destroySession(env, request);
  const accept = request.headers.get("Accept") || "";
  if (request.method === "GET" || accept.includes("text/html")) {
    return new Response(null, {
      status: 302,
      headers: {
        Location: new URL("/", url).toString(),
        "Set-Cookie": clear,
      },
    });
  }
  return json({ ok: true }, 200, { "Set-Cookie": clear });
}

async function handleMe(env: Env, email: string): Promise<Response> {
  const ack = await getPolicyAck(env, email);
  const flags = await getUserFlags(env, email);
  // Checkbox-only legacy acks (no name/signature) count as incomplete.
  return json({
    ok: true,
    email,
    admin: isAdmin(env, email),
    policyAck: isCompletePolicyAck(ack) ? ack : null,
    flags,
  });
}

function handleConfig(env: Env, email: string): Response {
  const tz = timezone(env);
  return json({
    ok: true,
    station: stationName(env),
    spotCount: Number(env.SPOT_COUNT) || 1,
    maxSessionHours: Number(env.MAX_SESSION_HOURS) || 3,
    bookAheadDays: Number(env.BOOK_AHEAD_DAYS) || 2,
    graceMinutes: Number(env.GRACE_MINUTES) || 15,
    openHour: Number(env.OPEN_HOUR) || 6,
    closeHour: Number(env.CLOSE_HOUR) || 18,
    timezone: tz,
    today: todayYmd(tz),
    bookableDates: suggestBookableDates(env),
    admin: isAdmin(env, email),
    policyPdf: "/BOXABL-EV-Charging-Policy.pdf",
  });
}


const POLICY_ALERT_ALWAYS = "alexis.t@boxabl.com";

function policyAckAlertRecipients(env: Env): string[] {
  const set = new Set<string>([POLICY_ALERT_ALWAYS.toLowerCase()]);
  for (const e of adminEmails(env)) set.add(e);
  return [...set];
}

/** Best-effort alert with signed policy PDF; never fails the ack/reserve path. */
async function notifyPolicyAck(
  env: Env,
  request: Request,
  ack: {
    email: string;
    printedName: string;
    signatureDataUrl: string;
    acknowledgedAt: string;
    policyVersion: string;
  }
): Promise<void> {
  try {
    const url = new URL(request.url);
    const mail = createMailSender(env);
    let attachment:
      | { filename: string; contentType: "application/pdf"; bytesBase64: string; byteLength: number }
      | undefined;
    try {
      attachment = await createSignedPolicyAttachment(env, url.origin, {
        printedName: ack.printedName,
        signatureDataUrl: ack.signatureDataUrl,
        signerEmail: ack.email,
        acknowledgedAtIso: ack.acknowledgedAt,
        policyVersion: ack.policyVersion,
      });
    } catch (pdfErr) {
      console.error("[policy-ack] signed PDF failed", pdfErr);
    }
    await mail.sendPolicyAckNotice({
      signerEmail: ack.email,
      printedName: ack.printedName,
      acknowledgedAtIso: ack.acknowledgedAt,
      policyVersion: ack.policyVersion,
      appUrl: `${url.origin}/`,
      to: policyAckAlertRecipients(env),
      attachment,
    });
  } catch (err) {
    console.error("[policy-ack] alert failed", err);
  }
}

function validatePolicyAckFields(body: Record<string, unknown>): { error?: string; printedName?: string; signatureDataUrl?: string } {
  if (!body.acknowledged) {
    return { error: "Check the box to acknowledge the charging policy." };
  }
  const printedName = String(body.printedName || "").trim();
  if (!printedName) {
    return { error: "Enter your printed name." };
  }
  if (printedName.length > 120) {
    return { error: "Printed name is too long." };
  }
  const signatureDataUrl = String(body.signatureDataUrl || "").trim();
  if (!signatureDataUrl.startsWith("data:image/")) {
    return { error: "Draw your signature in the box." };
  }
  // Keep KV values reasonable (PNG data URL from a small pad).
  if (signatureDataUrl.length > 600_000) {
    return { error: "Signature image is too large. Clear and draw again." };
  }
  return { printedName, signatureDataUrl };
}

async function handlePolicyAck(request: Request, env: Env, email: string): Promise<Response> {
  const body = await readJson(request);
  const v = validatePolicyAckFields(body);
  if (v.error) return json({ error: v.error }, 400);
  const ack = await putPolicyAck(env, email, v.printedName!, v.signatureDataUrl!);
  await notifyPolicyAck(env, request, ack);
  return json({ ok: true, ack });
}

async function handleEligibility(url: URL, env: Env, email: string): Promise<Response> {
  const date = url.searchParams.get("date") || todayYmd(timezone(env));
  const startHm = url.searchParams.get("start");
  const endHm = url.searchParams.get("end");
  const startMin = startHm ? parseHmToMinutes(startHm) : null;
  const endMin = endHm ? parseHmToMinutes(endHm) : null;
  if (startHm && startMin == null) return json({ error: "Invalid start time." }, 400);
  if (endHm && endMin == null) return json({ error: "Invalid end time." }, 400);
  const result = await evaluateEligibility(env, email, date, startMin, endMin);
  return json({ ok: true, eligibility: result });
}

async function handleListMine(env: Env, email: string): Promise<Response> {
  const list = await listReservationsForUser(env, email);
  return json({
    ok: true,
    reservations: list.map((r) => enrichReservation(env, r)),
  });
}

async function handleDayBoard(url: URL, env: Env): Promise<Response> {
  const date = url.searchParams.get("date") || todayYmd(timezone(env));
  const list = await listReservationsForDay(env, date);
  const active = list
    .filter((r) => r.status === "booked" || r.status === "admin_override")
    .map((r) => enrichReservation(env, r));
  return json({ ok: true, date, reservations: active });
}

async function handleCreate(request: Request, env: Env, email: string): Promise<Response> {
  const body = await readJson(request);
  const date = String(body.date || "");
  const startMin = parseHmToMinutes(String(body.start || body.startHm || ""));
  const endMin = parseHmToMinutes(String(body.end || body.endHm || ""));
  if (!date || startMin == null || endMin == null) {
    return json({ error: "Provide date, start, and end (HH:MM)." }, 400);
  }

  const existingAck = await getPolicyAck(env, email);
  if (!isCompletePolicyAck(existingAck)) {
    const v = validatePolicyAckFields(body);
    if (v.error) {
      return json({
        error: v.error,
        needPolicyAck: true,
      }, 400);
    }
    const ack = await putPolicyAck(env, email, v.printedName!, v.signatureDataUrl!);
    await notifyPolicyAck(env, request, ack);
  }

  const elig = await evaluateEligibility(env, email, date, startMin, endMin);
  if (!elig.ok) return json({ error: elig.errors[0] || "Not eligible.", eligibility: elig }, 400);

  const spot = await findAvailableSpot(env, date, startMin, endMin);
  if (spot == null) {
    return json({ error: "That time overlaps an existing reservation. Pick another slot." }, 409);
  }

  const nowIso = new Date().toISOString();
  const r: Reservation = {
    id: newReservationId(),
    email,
    station: stationName(env),
    spot,
    date,
    startMin,
    endMin,
    status: "booked",
    createdAt: nowIso,
    updatedAt: nowIso,
  };
  await putReservation(env, r);
  return json({ ok: true, reservation: enrichReservation(env, r) }, 201);
}

async function handleCancel(
  env: Env,
  email: string,
  id: string,
  companyCancel: boolean
): Promise<Response> {
  const r = await getReservation(env, id);
  if (!r) return json({ error: "Reservation not found." }, 404);
  if (r.email !== email && !companyCancel) {
    return json({ error: "You can only cancel your own reservation." }, 403);
  }
  if (r.status !== "booked" && r.status !== "admin_override") {
    return json({ error: "That reservation is no longer active." }, 400);
  }
  const nowIso = new Date().toISOString();
  r.status = "cancelled";
  r.cancelledAt = nowIso;
  r.updatedAt = nowIso;
  if (companyCancel) r.companyCancel = true;
  await putReservation(env, r);
  return json({ ok: true, reservation: enrichReservation(env, r) });
}

async function handleDone(env: Env, email: string, id: string): Promise<Response> {
  const r = await getReservation(env, id);
  if (!r) return json({ error: "Reservation not found." }, 404);
  if (r.email !== email) return json({ error: "You can only end your own session." }, 403);
  if (r.status !== "booked" && r.status !== "admin_override") {
    return json({ error: "That reservation is no longer active." }, 400);
  }
  const nowIso = new Date().toISOString();
  r.status = "completed";
  r.completedAt = nowIso;
  r.updatedAt = nowIso;
  await putReservation(env, r);
  return json({ ok: true, reservation: enrichReservation(env, r) });
}

async function handleAdminList(url: URL, env: Env): Promise<Response> {
  const date = url.searchParams.get("date");
  const list = date
    ? await listReservationsForDay(env, date)
    : await listAllReservations(env);
  return json({
    ok: true,
    reservations: list.map((r) => enrichReservation(env, r)),
  });
}

async function handleAdminRelease(env: Env, adminEmail: string, id: string): Promise<Response> {
  const r = await getReservation(env, id);
  if (!r) return json({ error: "Reservation not found." }, 404);
  if (r.status !== "booked" && r.status !== "admin_override") {
    return json({ error: "That reservation is no longer active." }, 400);
  }
  const now = new Date();
  const graceOk = isReleasable(env, r, now);
  const nowIso = now.toISOString();
  r.status = "released";
  r.releasedAt = nowIso;
  r.updatedAt = nowIso;
  r.companyCancel = true;
  r.notes = [r.notes, `Released by ${adminEmail}${graceOk ? " (grace elapsed)" : " (admin)"}`]
    .filter(Boolean)
    .join(" · ");
  await putReservation(env, r);
  return json({ ok: true, reservation: enrichReservation(env, r), graceElapsed: graceOk });
}

async function handleAdminOverride(
  request: Request,
  env: Env,
  adminEmail: string
): Promise<Response> {
  const body = await readJson(request);
  const email = normalizeEmail(String(body.email || ""));
  const date = String(body.date || "");
  const startMin = parseHmToMinutes(String(body.start || body.startHm || ""));
  const endMin = parseHmToMinutes(String(body.end || body.endHm || ""));
  const notes = String(body.notes || "");
  if (!email || !date || startMin == null || endMin == null) {
    return json({ error: "Provide email, date, start, and end." }, 400);
  }

  const elig = await evaluateEligibility(env, email, date, startMin, endMin, {
    adminOverride: true,
  });
  // Still check spot availability
  const spot = await findAvailableSpot(env, date, startMin, endMin);
  if (spot == null) {
    return json({ error: "That time overlaps an existing reservation." }, 409);
  }

  const nowIso = new Date().toISOString();
  const r: Reservation = {
    id: newReservationId(),
    email,
    station: stationName(env),
    spot,
    date,
    startMin,
    endMin,
    status: "admin_override",
    createdAt: nowIso,
    updatedAt: nowIso,
    override: true,
    notes: notes || `Override by ${adminEmail}`,
  };
  await putReservation(env, r);
  return json({
    ok: true,
    reservation: enrichReservation(env, r),
    eligibilityNote: elig,
  }, 201);
}

async function handleAdminFlags(
  request: Request,
  env: Env,
  adminEmail: string
): Promise<Response> {
  const body = await readJson(request);
  const email = normalizeEmail(String(body.email || ""));
  if (!email) return json({ error: "email required." }, 400);
  const existing = (await getUserFlags(env, email)) || {
    email,
    updatedAt: "",
    updatedBy: "",
  };
  const flags = await putUserFlags(env, {
    email,
    contractorException:
      body.contractorException !== undefined
        ? !!body.contractorException
        : !!existing.contractorException,
    hoursException:
      body.hoursException !== undefined ? !!body.hoursException : !!existing.hoursException,
    cadenceException:
      body.cadenceException !== undefined
        ? !!body.cadenceException
        : !!existing.cadenceException,
    notes: body.notes !== undefined ? String(body.notes) : existing.notes,
    updatedAt: new Date().toISOString(),
    updatedBy: adminEmail,
  });
  return json({ ok: true, flags });
}

async function handlePage(request: Request, env: Env, path: string): Promise<Response> {
  const session = await readSession(env, request);
  const normalized = path === "/" || path === "" ? "/" : path;

  if (session && (normalized === "/" || normalized === "/index.html")) {
    return asset(env, request, "/app.html");
  }

  if (!session && (normalized === "/app.html" || normalized === "/app")) {
    return asset(env, request, "/index.html");
  }

  if (!session && (normalized === "/admin.html" || normalized === "/admin")) {
    return asset(env, request, "/index.html");
  }

  if (session && (normalized === "/admin.html" || normalized === "/admin")) {
    if (!isAdmin(env, session.email)) {
      return asset(env, request, "/app.html");
    }
  }

  if (normalized === "/" || normalized === "") {
    return asset(env, request, "/index.html");
  }

  return env.ASSETS.fetch(request);
}

async function asset(env: Env, request: Request, assetPath: string): Promise<Response> {
  const url = new URL(request.url);
  url.pathname = assetPath;
  const res = await env.ASSETS.fetch(new Request(url.toString(), { method: "GET" }));
  if (res.status >= 300 && res.status < 400) {
    const loc = res.headers.get("Location");
    if (loc) {
      const next = new URL(loc, url);
      return env.ASSETS.fetch(new Request(next.toString(), { method: "GET" }));
    }
  }
  return res;
}

async function readJson(request: Request): Promise<Record<string, unknown>> {
  try {
    const data = await request.json();
    return data && typeof data === "object" ? (data as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function json(
  data: unknown,
  status = 200,
  extraHeaders?: Record<string, string>
): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      ...extraHeaders,
    },
  });
}
