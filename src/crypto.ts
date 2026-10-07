/** Web Crypto helpers for OTP hashing and HMAC session tokens. */

const te = new TextEncoder();

export function randomDigits(length: number): string {
  const buf = new Uint8Array(length);
  crypto.getRandomValues(buf);
  let out = "";
  for (let i = 0; i < length; i++) out += String(buf[i] % 10);
  return out;
}

export function randomId(bytes = 24): string {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return [...buf].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function sha256Hex(input: string): Promise<string> {
  const dig = await crypto.subtle.digest("SHA-256", te.encode(input));
  return [...new Uint8Array(dig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    te.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"]
  );
}

export async function signPayload(secret: string, payloadB64: string): Promise<string> {
  const key = await hmacKey(secret);
  const sig = await crypto.subtle.sign("HMAC", key, te.encode(payloadB64));
  return b64url(new Uint8Array(sig));
}

export async function verifySignature(
  secret: string,
  payloadB64: string,
  signatureB64: string
): Promise<boolean> {
  const expected = await signPayload(secret, payloadB64);
  if (expected.length !== signatureB64.length) return false;
  let ok = 0;
  for (let i = 0; i < expected.length; i++) {
    ok |= expected.charCodeAt(i) ^ signatureB64.charCodeAt(i);
  }
  return ok === 0;
}

export function b64url(data: Uint8Array | string): string {
  const raw =
    typeof data === "string"
      ? btoa(data)
      : btoa(String.fromCharCode(...data));
  return raw.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

export function b64urlJson(obj: unknown): string {
  return b64url(JSON.stringify(obj));
}

export function parseB64urlJson<T>(payloadB64: string): T | null {
  try {
    const padded = payloadB64.replace(/-/g, "+").replace(/_/g, "/");
    const pad = padded.length % 4 === 0 ? "" : "=".repeat(4 - (padded.length % 4));
    const json = atob(padded + pad);
    return JSON.parse(json) as T;
  } catch {
    return null;
  }
}
