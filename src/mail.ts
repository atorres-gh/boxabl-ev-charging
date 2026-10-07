import type { Env } from "./env";

export interface PolicyAckAttachment {
  filename: string;
  contentType: "application/pdf";
  /** Base64-encoded PDF bytes (Graph contentBytes). */
  bytesBase64: string;
  /** Optional length for stub logging. */
  byteLength?: number;
}

export interface PolicyAckNotice {
  signerEmail: string;
  printedName: string;
  acknowledgedAtIso: string;
  policyVersion: string;
  appUrl: string;
  /** Recipients (already deduped). */
  to: string[];
  /** Signed policy PDF (company policy + acknowledgment page). */
  attachment?: PolicyAckAttachment;
}

export interface MailSender {
  /** Deliver a 6-digit OTP. Stub may no-op and rely on previewCode in the API response. */
  sendOtp(to: string, code: string): Promise<{ preview?: boolean }>;
  /** Notify Office Manager(s) that someone signed the EV policy. Never throw to callers — stub logs. */
  sendPolicyAckNotice(notice: PolicyAckNotice): Promise<{ preview?: boolean }>;
}

/**
 * Mail adapter. Plug Graph or SMTP later without changing the auth routes.
 * - stub  — local/dev; no outbound mail; API returns previewCode
 * - graph — Microsoft Graph sendMail (requires GRAPH_* secrets)
 * - smtp  — placeholder; throws until implemented
 */
export function createMailSender(env: Env): MailSender {
  const provider = (env.MAIL_PROVIDER || "stub").toLowerCase();
  if (provider === "graph") return new GraphMailSender(env);
  if (provider === "smtp") return new SmtpMailSender(env);
  return new StubMailSender();
}

class StubMailSender implements MailSender {
  async sendOtp(_to: string, _code: string): Promise<{ preview?: boolean }> {
    return { preview: true };
  }

  async sendPolicyAckNotice(notice: PolicyAckNotice): Promise<{ preview?: boolean }> {
    const { subject, body } = formatPolicyAckEmail(notice);
    const att = notice.attachment;
    const attLine = att
      ? `  attachment: ${att.filename} (${att.byteLength ?? Math.floor((att.bytesBase64.length * 3) / 4)} bytes, ${att.contentType})`
      : "  attachment: (none)";
    console.log(
      "[mail:stub] policy-ack notice\n" +
        `  to: ${notice.to.join(", ")}\n` +
        `  subject: ${subject}\n` +
        attLine +
        "\n" +
        body
          .split("\n")
          .map((l) => `  ${l}`)
          .join("\n")
    );
    if (att) {
      console.log(
        `[mail:stub] policy-ack signed PDF ${att.filename} ${att.byteLength ?? "?"} bytes`
      );
    }
    return { preview: true };
  }
}

class GraphMailSender implements MailSender {
  constructor(private env: Env) {}

  async sendOtp(to: string, code: string): Promise<{ preview?: boolean }> {
    const tenant = this.env.GRAPH_TENANT_ID;
    const clientId = this.env.GRAPH_CLIENT_ID;
    const clientSecret = this.env.GRAPH_CLIENT_SECRET;
    const sender = this.env.GRAPH_SENDER || this.env.MAIL_FROM;
    if (!tenant || !clientId || !clientSecret || !sender) {
      throw new Error(
        "Graph mail requires GRAPH_TENANT_ID, GRAPH_CLIENT_ID, GRAPH_CLIENT_SECRET, and GRAPH_SENDER (or MAIL_FROM)."
      );
    }

    const token = await fetchGraphToken(tenant, clientId, clientSecret);
    const subject = this.env.MAIL_SUBJECT || "Your BOXABL EV Charging sign-in code";
    const body = [
      "Your BOXABL EV Charging sign-in code is:",
      "",
      `  ${code}`,
      "",
      "It expires in 10 minutes. If you did not request this, you can ignore this email.",
    ].join("\n");

    const res = await fetch(
      `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(sender)}/sendMail`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          message: {
            subject,
            body: { contentType: "Text", content: body },
            toRecipients: [{ emailAddress: { address: to } }],
          },
          saveToSentItems: false,
        }),
      }
    );

    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new Error(`Graph sendMail failed (${res.status}): ${detail.slice(0, 200)}`);
    }
    return {};
  }

  async sendPolicyAckNotice(notice: PolicyAckNotice): Promise<{ preview?: boolean }> {
    if (!notice.to.length) return {};
    const tenant = this.env.GRAPH_TENANT_ID;
    const clientId = this.env.GRAPH_CLIENT_ID;
    const clientSecret = this.env.GRAPH_CLIENT_SECRET;
    const sender = this.env.GRAPH_SENDER || this.env.MAIL_FROM;
    if (!tenant || !clientId || !clientSecret || !sender) {
      console.warn("[mail:graph] policy-ack skipped — Graph secrets missing");
      return { preview: true };
    }
    const { subject, body } = formatPolicyAckEmail(notice);
    const message: Record<string, unknown> = {
      subject,
      body: { contentType: "Text", content: body },
      toRecipients: notice.to.map((address) => ({ emailAddress: { address } })),
    };
    if (notice.attachment?.bytesBase64) {
      message.attachments = [
        {
          "@odata.type": "#microsoft.graph.fileAttachment",
          name: notice.attachment.filename,
          contentType: notice.attachment.contentType || "application/pdf",
          contentBytes: notice.attachment.bytesBase64,
        },
      ];
    }
    const token = await fetchGraphToken(tenant, clientId, clientSecret);
    const res = await fetch(
      `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(sender)}/sendMail`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          message,
          saveToSentItems: false,
        }),
      }
    );
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      console.error(`Graph policy-ack sendMail failed (${res.status}): ${detail.slice(0, 200)}`);
      // Do not throw — ack already saved; alert is best-effort.
      return {};
    }
    return {};
  }
}

class SmtpMailSender implements MailSender {
  constructor(private env: Env) {}

  async sendOtp(_to: string, _code: string): Promise<{ preview?: boolean }> {
    void this.env;
    throw new Error(
      "SMTP provider is scaffolded only. Set MAIL_PROVIDER=graph or implement SmtpMailSender with SMTP_* secrets."
    );
  }

  async sendPolicyAckNotice(notice: PolicyAckNotice): Promise<{ preview?: boolean }> {
    void this.env;
    console.warn("[mail:smtp] policy-ack not implemented; logging only");
    const stub = new StubMailSender();
    return stub.sendPolicyAckNotice(notice);
  }
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

export function formatPolicyAckEmail(notice: PolicyAckNotice): { subject: string; body: string } {
  const subject = `EV charging policy signed — ${notice.printedName}`;
  const attNote = notice.attachment
    ? `Signed policy PDF attached: ${notice.attachment.filename}`
    : "Signed policy PDF could not be generated for this alert.";
  const body = [
    "Someone signed the on-site EV charging policy.",
    "",
    `Work email: ${notice.signerEmail}`,
    `Printed name: ${notice.printedName}`,
    `Signed at: ${formatPt(notice.acknowledgedAtIso)}`,
    `Policy version: ${notice.policyVersion}`,
    "",
    attNote,
    "",
    `App: ${notice.appUrl}`,
    "",
    "— BOXABL EV Charging",
  ].join("\n");
  return { subject, body };
}

async function fetchGraphToken(
  tenant: string,
  clientId: string,
  clientSecret: string
): Promise<string> {
  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    scope: "https://graph.microsoft.com/.default",
    grant_type: "client_credentials",
  });
  const res = await fetch(`https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`Graph token failed (${res.status}): ${detail.slice(0, 200)}`);
  }
  const data = (await res.json()) as { access_token?: string };
  if (!data.access_token) throw new Error("Graph token response missing access_token");
  return data.access_token;
}
