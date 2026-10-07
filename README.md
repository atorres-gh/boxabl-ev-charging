# BOXABL On-Site EV Charging (MVP)

Standalone reservation site for **F1 Charge Station** — not a Fabulous Tools Hub panel.

**Live (workers.dev smoke):** https://boxabl-ev-charging.alexis-t.workers.dev — `MAIL_PROVIDER=stub` (previewCode on page). Custom hostname / Graph mail still pending.

Employees with `@boxabl.com` email sign in via OTP, acknowledge the charging policy once, then book / cancel / end sessions under the Office Manager policy.

Policy source: `public/BOXABL-EV-Charging-Policy.pdf` (copied from the company PDF).

## Rules encoded (MVP)

| Rule | Behavior |
|------|----------|
| Station | `STATION_NAME` (default **F1 Charge Station**) |
| Spots | `SPOT_COUNT` (default **1**) |
| Who | `@boxabl.com` only; admin can flag **contractor exceptions** |
| Session | Max **3 hours**; one session per charging day |
| Cadence | **Every other business day** Mon–Fri (Mon→Wed, Fri→Tue; weekends don’t count) |
| Hours | **06:00–18:00** `America/Los_Angeles`; no overnight/weekend without **hours exception** flag |
| Book ahead | ≤ **2** calendar days |
| Grace | **15 minutes** after start → marked releasable; admin can release anytime |
| Cancel / I’m done | Frees the stall early |
| First book | Policy checkbox + **printed name** + **drawn signature** + stored ack (email, name, signature PNG, timestamp, version `2026-onsite-ev-v3` on new signs) |
| Admin | `ADMIN_EMAILS` comma list — list, release, override, flags, policy acks |

**Not modeled yet:** company holiday calendar (weekends only); founder/exec priority bump workflow; Outlook room resource sync (this app replaces Outlook booking for the MVP).

## Policy sign alerts

Every successful policy acknowledgment (standalone `POST /api/policy-ack` or first-reserve path) notifies **alexis.t@boxabl.com** and any other addresses in `ADMIN_EMAILS`.

- Subject: `EV charging policy signed — {printedName}`
- Body: signer email, printed name, signed-at (PT), policy version, app link.
- **Attachment:** signed policy PDF = company policy + an **Acknowledgment** page with printed name, drawn signature image, date (PT), work email, and policy version. Filename like `BOXABL-EV-Charging-Policy-signed-{name}-{ymd}.pdf`. PDF is built at send time from the stored name/signature (not re-stored in KV).
- New acks store version `2026-onsite-ev-v3`. Existing complete name+signature acks stay complete (no forced re-sign).
- `MAIL_PROVIDER=stub` (current workers.dev): logs subject/to/body and `[mail:stub] policy-ack signed PDF …` with filename + byte length; ack still succeeds.
- `MAIL_PROVIDER=graph`: Outlook sendMail with `#microsoft.graph.fileAttachment` (`contentBytes` base64). Mail failure never blocks the ack.

## Stack

Cloudflare **Workers** + static `public/` assets, TypeScript, Wrangler, single **KV** namespace (`EV_STORE`) for OTP, sessions, reservations, policy acks, and user flags. `MAIL_PROVIDER=stub` returns `previewCode` on the sign-in page (same pattern as Fabulous Tools Hub).

Palette: paper `#f4f1ea`, ink `#0b1d36`, navy `#184273`, accent `#ffa400`. Body font: Lato.

## Layout

```
wrangler.toml
package.json
.dev.vars.example
src/
  index.ts           Routes, page gate, APIs
  otp.ts / session.ts / mail.ts / crypto.ts / env.ts
  time.ts            America/Los_Angeles helpers
  store.ts           KV reservations + acks + flags
  signed-policy-pdf.ts  Stamp name/signature/date onto policy PDF
  eligibility.ts     Cadence, hours, spots, grace
public/
  index.html         Sign-in
  app.html + app.js  Employee reserve UI
  admin.html + admin.js  Office Manager tools
  styles.css
  favicon.svg
  BOXABL-EV-Charging-Policy.pdf
README.md
GROK.md
```

## Local run

```bash
cd /workspace/boxabl-ev-charging
npm install
cp .dev.vars.example .dev.vars   # set SESSION_SECRET + ADMIN_EMAILS
npm run dev                      # http://localhost:8787
```

1. Open `/` — enter any `you@boxabl.com`.
2. Stub mail shows **previewCode** on the page.
3. After verify → `/app.html`. Admins in `ADMIN_EMAILS` can open `/admin.html`.
4. First reserve: check policy ack (PDF link), type printed name, draw signature, then book.
5. On each successful policy sign, the app emails **alexis.t@boxabl.com** plus everyone in `ADMIN_EMAILS` with the **signed policy PDF** attached (stub logs filename + size; Graph sends when `MAIL_PROVIDER=graph`).

Local KV uses Wrangler’s miniflare preview automatically (placeholder ids in `wrangler.toml` are fine for `wrangler dev`).

## API sketch

| Method | Path | Notes |
|--------|------|--------|
| `POST` | `/api/auth/request` | `{ email }` → optional `previewCode` |
| `POST` | `/api/auth/verify` | `{ email, code }` → session cookie |
| `POST`/`GET` | `/api/auth/logout` | Clear session |
| `GET` | `/api/me` | email, admin, policyAck, flags |
| `GET` | `/api/config` | station constants + bookable dates |
| `GET`/`POST` | `/api/policy-ack` | Read / store acknowledgment |
| `GET` | `/api/eligibility?date&start&end` | Cadence + hours check |
| `GET`/`POST` | `/api/reservations` | List mine / create |
| `POST` | `/api/reservations/:id/cancel` | User cancel |
| `POST` | `/api/reservations/:id/done` | Early end |
| `GET` | `/api/day?date=` | Active board for a day |
| `GET` | `/api/admin/reservations` | All (or `?date=`) |
| `POST` | `/api/admin/reservations/:id/release` | Company release |
| `POST` | `/api/admin/override` | Admin book bypassing cadence |
| `GET`/`POST` | `/api/admin/flags` | Contractor / hours / cadence flags |
| `GET` | `/api/admin/policy-acks` | Ack list |

## Deploy (when company Cloudflare is ready)

1. `npx wrangler login`
2. `npm run kv:create` — paste `id` + `preview_id` into `wrangler.toml`
3. Secrets:

   ```bash
   npx wrangler secret put SESSION_SECRET
   # Edit ADMIN_EMAILS in wrangler.toml [vars] (or set in dashboard)
   # When mail goes live:
   npx wrangler secret put GRAPH_TENANT_ID
   npx wrangler secret put GRAPH_CLIENT_ID
   npx wrangler secret put GRAPH_CLIENT_SECRET
   npx wrangler secret put GRAPH_SENDER
   ```

4. Set `MAIL_PROVIDER = "graph"` in `wrangler.toml` (or keep `stub` for smoke).
5. `npm run deploy`
6. Attach hostname when Boss picks the URL. **Do not** create a GitHub remote here — Boss opens an empty repo later.

## Env / vars

| Name | Where | Purpose |
|------|--------|---------|
| `SESSION_SECRET` | secret / `.dev.vars` | Cookie HMAC + OTP salt |
| `ADMIN_EMAILS` | `[vars]` / `.dev.vars` | Comma-separated Office Manager emails (keep out of empty `[vars]` placeholder — empty string overrides) |
| `ALLOWED_EMAIL_DOMAIN` | vars | Default `boxabl.com` |
| `SPOT_COUNT` | vars | Default `1` |
| `STATION_NAME` | vars | Default `F1 Charge Station` |
| `MAX_SESSION_HOURS` / `BOOK_AHEAD_DAYS` / `GRACE_MINUTES` | vars | Policy knobs |
| `OPEN_HOUR` / `CLOSE_HOUR` / `TIMEZONE` | vars | `6` / `18` / `America/Los_Angeles` |
| `MAIL_PROVIDER` | vars | `stub` \| `graph` |
| `GRAPH_*` | secrets | Live OTP mail |

## Shan handoff — open gaps

1. Real KV namespace ids + Cloudflare login / deploy hostname.
2. Graph mail (or approved SMTP) for production OTP.
3. Holiday calendar if OM wants holidays treated like weekends.
4. Founder/exec priority “bump” notifications (email/Teams) — not in MVP.
5. Optional sync or sunset of Outlook **F1 - Charge Station** room resource.
6. Boss creates empty GitHub repo; push when ready (no remote in this scaffold).
