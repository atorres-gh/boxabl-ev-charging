import type { Env } from "./env";
import { num } from "./env";
import { b64urlJson, parseB64urlJson, randomId, signPayload, verifySignature } from "./crypto";

export interface SessionClaims {
  sid: string;
  email: string;
  exp: number;
}

interface SessionRecord {
  email: string;
  exp: number;
}

function cookieName(env: Env): string {
  return env.COOKIE_NAME || "boxabl_ev_session";
}

export async function createSession(
  env: Env,
  email: string,
  secure: boolean
): Promise<{ cookie: string; sid: string }> {
  const ttl = num(env.SESSION_TTL_SECONDS, 43_200);
  const sid = randomId(24);
  const exp = Math.floor(Date.now() / 1000) + ttl;
  const record: SessionRecord = { email, exp };
  await env.EV_STORE.put(`session:${sid}`, JSON.stringify(record), {
    expirationTtl: ttl,
  });

  const claims: SessionClaims = { sid, email, exp };
  const payload = b64urlJson(claims);
  const sig = await signPayload(requireSecret(env), payload);
  const token = `${payload}.${sig}`;
  const cookie = serializeCookie(cookieName(env), token, {
    maxAge: ttl,
    httpOnly: true,
    secure,
    sameSite: "Lax",
    path: "/",
  });
  return { cookie, sid };
}

export async function readSession(env: Env, request: Request): Promise<SessionClaims | null> {
  const raw = parseCookie(request.headers.get("Cookie") || "")[cookieName(env)];
  if (!raw) return null;
  const parts = raw.split(".");
  if (parts.length !== 2) return null;
  const [payload, sig] = parts;
  const secret = env.SESSION_SECRET;
  if (!secret) return null;
  if (!(await verifySignature(secret, payload, sig))) return null;
  const claims = parseB64urlJson<SessionClaims>(payload);
  if (!claims?.sid || !claims.email || !claims.exp) return null;
  if (claims.exp * 1000 < Date.now()) return null;

  const stored = await env.EV_STORE.get(`session:${claims.sid}`, "json");
  const record = stored as SessionRecord | null;
  if (!record || record.email !== claims.email) return null;
  if (record.exp * 1000 < Date.now()) {
    await env.EV_STORE.delete(`session:${claims.sid}`);
    return null;
  }
  return claims;
}

export async function destroySession(env: Env, request: Request): Promise<string> {
  const session = await readSession(env, request);
  if (session) await env.EV_STORE.delete(`session:${session.sid}`);
  const secure = new URL(request.url).protocol === "https:";
  return serializeCookie(cookieName(env), "", {
    maxAge: 0,
    httpOnly: true,
    secure,
    sameSite: "Lax",
    path: "/",
  });
}

function requireSecret(env: Env): string {
  if (!env.SESSION_SECRET) {
    throw new Error("SESSION_SECRET is not set. Use wrangler secret put or .dev.vars.");
  }
  return env.SESSION_SECRET;
}

function parseCookie(header: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx < 0) continue;
    const k = part.slice(0, idx).trim();
    const v = part.slice(idx + 1).trim();
    if (k) out[k] = decodeURIComponent(v);
  }
  return out;
}

function serializeCookie(
  name: string,
  value: string,
  opts: { maxAge: number; httpOnly: boolean; secure: boolean; sameSite: string; path: string }
): string {
  const bits = [
    `${name}=${encodeURIComponent(value)}`,
    `Path=${opts.path}`,
    `Max-Age=${opts.maxAge}`,
    `SameSite=${opts.sameSite}`,
  ];
  if (opts.httpOnly) bits.push("HttpOnly");
  if (opts.secure) bits.push("Secure");
  return bits.join("; ");
}
