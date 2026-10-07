import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import type { Env } from "./env";

export interface SignedPolicyInput {
  printedName: string;
  signatureDataUrl: string;
  signerEmail: string;
  acknowledgedAtIso: string;
  policyVersion: string;
}

export interface SignedPolicyPdf {
  bytes: Uint8Array;
  filename: string;
  bytesBase64: string;
}

const POLICY_ASSET_PATH = "/BOXABL-EV-Charging-Policy.pdf";

/** Load blank company policy PDF from ASSETS (Workers deploy). */
export async function loadBlankPolicyPdf(env: Env, origin: string): Promise<Uint8Array> {
  const url = new URL(POLICY_ASSET_PATH, origin);
  const res = await env.ASSETS.fetch(new Request(url.toString(), { method: "GET" }));
  if (!res.ok) {
    throw new Error(`Could not load policy PDF (${res.status}).`);
  }
  const buf = await res.arrayBuffer();
  if (!buf.byteLength) {
    throw new Error("Policy PDF asset was empty.");
  }
  return new Uint8Array(buf);
}

function formatPt(iso: string): string {
  try {
    return (
      new Intl.DateTimeFormat("en-US", {
        timeZone: "America/Los_Angeles",
        dateStyle: "medium",
        timeStyle: "short",
      }).format(new Date(iso)) + " PT"
    );
  } catch {
    return iso;
  }
}

function ymdPt(iso: string): string {
  try {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: "America/Los_Angeles",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(new Date(iso));
    const y = parts.find((p) => p.type === "year")?.value || "0000";
    const m = parts.find((p) => p.type === "month")?.value || "00";
    const d = parts.find((p) => p.type === "day")?.value || "00";
    return `${y}${m}${d}`;
  } catch {
    return "00000000";
  }
}

function sanitizeFilenamePart(name: string): string {
  const cleaned = name
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  return (cleaned || "signer").slice(0, 60);
}

function parsePngDataUrl(dataUrl: string): Uint8Array {
  const m = /^data:image\/png;base64,(.+)$/i.exec(dataUrl.trim());
  if (!m) {
    throw new Error("Signature must be a PNG data URL.");
  }
  const binary = atob(m[1]);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

function uint8ToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

/**
 * Company policy PDF + Acknowledgment page (printed name, signature image, date).
 * Does not mutate the blank asset; returns new bytes for email attachment only.
 */
export async function buildSignedPolicyPdf(
  blankPdfBytes: Uint8Array,
  input: SignedPolicyInput
): Promise<SignedPolicyPdf> {
  const pdf = await PDFDocument.load(blankPdfBytes);
  const page = pdf.addPage();
  const { width, height } = page.getSize();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const fontBold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const ink = rgb(0.04, 0.11, 0.21);
  const muted = rgb(0.35, 0.4, 0.45);
  const line = rgb(0.7, 0.72, 0.75);

  const margin = 56;
  let y = height - margin;

  const drawLabel = (text: string) => {
    page.drawText(text, { x: margin, y, size: 10, font: fontBold, color: muted });
    y -= 18;
  };
  const drawValue = (text: string, size = 12) => {
    page.drawText(text, { x: margin, y, size, font, color: ink, maxWidth: width - margin * 2 });
    y -= size + 14;
  };

  page.drawText("Acknowledgment", {
    x: margin,
    y,
    size: 18,
    font: fontBold,
    color: ink,
  });
  y -= 28;

  page.drawText(
    "I acknowledge that I have read and agree to the BOXABL on-site EV charging policy.",
    {
      x: margin,
      y,
      size: 11,
      font,
      color: ink,
      maxWidth: width - margin * 2,
      lineHeight: 14,
    }
  );
  y -= 40;

  drawLabel("Printed name");
  drawValue(input.printedName || "—", 14);

  drawLabel("Work email");
  drawValue(input.signerEmail || "—");

  drawLabel("Date signed");
  drawValue(formatPt(input.acknowledgedAtIso));

  drawLabel("Policy version");
  drawValue(input.policyVersion || "—");

  drawLabel("Signature");
  y -= 4;

  const sigBytes = parsePngDataUrl(input.signatureDataUrl);
  const sigImage = await pdf.embedPng(sigBytes);
  const maxW = Math.min(320, width - margin * 2);
  const maxH = 100;
  const scale = Math.min(maxW / sigImage.width, maxH / sigImage.height, 1);
  const sigW = sigImage.width * scale;
  const sigH = sigImage.height * scale;
  const boxPad = 8;
  const boxW = Math.max(sigW + boxPad * 2, 200);
  const boxH = sigH + boxPad * 2;

  page.drawRectangle({
    x: margin,
    y: y - boxH,
    width: boxW,
    height: boxH,
    borderColor: line,
    borderWidth: 1,
    color: rgb(1, 1, 1),
  });
  page.drawImage(sigImage, {
    x: margin + boxPad,
    y: y - boxH + boxPad,
    width: sigW,
    height: sigH,
  });
  y -= boxH + 28;

  page.drawText("Generated by BOXABL EV Charging — for Office Manager records.", {
    x: margin,
    y: Math.max(margin, y),
    size: 9,
    font,
    color: muted,
  });

  const bytes = await pdf.save();
  const filename = `BOXABL-EV-Charging-Policy-signed-${sanitizeFilenamePart(input.printedName)}-${ymdPt(input.acknowledgedAtIso)}.pdf`;
  return {
    bytes,
    filename,
    bytesBase64: uint8ToBase64(bytes),
  };
}

/** Load blank policy + stamp acknowledgment. Failures bubble to caller (best-effort mail). */
export async function createSignedPolicyAttachment(
  env: Env,
  origin: string,
  input: SignedPolicyInput
): Promise<{ filename: string; contentType: "application/pdf"; bytesBase64: string; byteLength: number }> {
  const blank = await loadBlankPolicyPdf(env, origin);
  const signed = await buildSignedPolicyPdf(blank, input);
  return {
    filename: signed.filename,
    contentType: "application/pdf",
    bytesBase64: signed.bytesBase64,
    byteLength: signed.bytes.byteLength,
  };
}
