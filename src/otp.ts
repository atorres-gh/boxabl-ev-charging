import type { Env } from "./env";
import { num } from "./env";
import { randomDigits, sha256Hex } from "./crypto";

const OTP_LENGTH = 6;
const MAX_ATTEMPTS = 5;

interface OtpRecord {
  hash: string;
  exp: number;
  attempts: number;
}

export function normalizeEmail(raw: string): string {
  return raw.trim().toLowerCase();
}

export function assertAllowedEmail(email: string, domain: string): string | null {
  const d = (domain || "boxabl.com").toLowerCase().replace(/^@/, "");
  if (!email || !email.includes("@")) return "Enter a valid work email.";
  const at = email.lastIndexOf("@");
  const host = email.slice(at + 1);
  if (host !== d) return "Use your @boxabl.com work email.";
  return null;
}

export async function issueOtp(env: Env, email: string): Promise<{ code: string; ttl: number }> {
  const ttl = num(env.OTP_TTL_SECONDS, 600);
  const code = randomDigits(OTP_LENGTH);
  const hash = await sha256Hex(`${email}:${code}:${env.SESSION_SECRET || "dev"}`);
  const record: OtpRecord = {
    hash,
    exp: Math.floor(Date.now() / 1000) + ttl,
    attempts: 0,
  };
  await env.EV_STORE.put(`otp:${email}`, JSON.stringify(record), { expirationTtl: ttl });
  return { code, ttl };
}

export async function verifyOtp(
  env: Env,
  email: string,
  code: string
): Promise<{ ok: true } | { ok: false; error: string }> {
  const cleaned = String(code || "").replace(/\D/g, "");
  if (cleaned.length !== OTP_LENGTH) {
    return { ok: false, error: "Enter the 6-digit code." };
  }

  const key = `otp:${email}`;
  const record = (await env.EV_STORE.get(key, "json")) as OtpRecord | null;
  if (!record) return { ok: false, error: "That code did not work." };
  if (record.exp * 1000 < Date.now()) {
    await env.EV_STORE.delete(key);
    return { ok: false, error: "That code expired. Request a new one." };
  }
  if (record.attempts >= MAX_ATTEMPTS) {
    await env.EV_STORE.delete(key);
    return { ok: false, error: "Too many attempts. Request a new code." };
  }

  const hash = await sha256Hex(`${email}:${cleaned}:${env.SESSION_SECRET || "dev"}`);
  if (hash !== record.hash) {
    record.attempts += 1;
    const remaining = Math.max(1, record.exp - Math.floor(Date.now() / 1000));
    await env.EV_STORE.put(key, JSON.stringify(record), { expirationTtl: remaining });
    return { ok: false, error: "That code did not work." };
  }

  await env.EV_STORE.delete(key);
  return { ok: true };
}
