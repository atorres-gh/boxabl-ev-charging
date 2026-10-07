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
| Admin | Built-in `ADMIN_EMAILS` seed ∪ KV extras (Admins tab) — list, release, override, flags, policy acks, **download signed PDF**, **external override** / **revoke** ack, add/remove extra admins |

**Not modeled yet:** company holiday calendar (weekends only); founder/exec priority bump workflow.

**Outlook room sync (live code, stub by default):** two-way with **cs1@boxabl.com** (display **F1 - Charge Station**). See below.

## Policy sign alerts

Every successful policy acknowledgment (standalone `POST /api/policy-ack` or first-reserve path) notifies **alexis.t@boxabl.com** and every admin (built-in `ADMIN_EMAILS` plus extras added in the Admin UI).

- Subject: `EV charging policy signed — {printedName}`
- Body: signer email, printed name, signed-at (PT), policy version, app link.
- **Attachment:** signed policy PDF = company policy + an **Acknowledgment** page with printed name, drawn signature image, date (PT), work email, and policy version. Filename like `BOXABL-EV-Charging-Policy-signed-{name}-{ymd}.pdf`. PDF is built at send time from the stored name/signature (not re-stored in KV). Admins can also **Download signed PDF** from the Policy acks tab (same rebuild).
- New acks store version `2026-onsite-ev-v3`. Existing complete name+signature acks stay complete (no forced re-sign).
- `MAIL_PROVIDER=stub` (current workers.dev): logs subject/to/body and `[mail:stub] policy-ack signed PDF …` with filename + byte length; ack still succeeds.
- `MAIL_PROVIDER=graph`: Outlook sendMail with `#microsoft.graph.fileAttachment` (`contentBytes` base64). Mail failure never blocks the ack.



## Outlook room sync (F1 - Charge Station)

Two-way sync with room mailbox **`cs1@boxabl.com`** (`OUTLOOK_ROOM_EMAIL`), display name **F1 - Charge Station**.

### Policy event format (App → Outlook)
- **Subject:** employee’s printed name (from policy ack); else Title Case from email local-part
- **Location:** `F1 - Charge Station`
- **No Teams** meeting
- Start/end = reservation window in `America/Los_Angeles`
- Create/update on reserve (and admin override); **delete** on cancel / I’m done / admin release

### Outlook → App
- **Cron every 5 minutes** (`[triggers] crons`) runs a **calendarView** reconcile for today … +14 days (chosen over Graph change-notification webhooks — simpler on Workers; no subscription renewal).
- Admins can also **Pull from Outlook now** on the Admin reservations tab (`POST /api/admin/outlook-sync`).
- New room events become app reservations (`source: outlook`), keep the stall blocked on the day board, and store `outlookEventId` / `iCalUId`.
- Person mapping: organizer/attendee `@boxabl.com`, else match subject to a known policy printed name, else **unknown** (`outlook-unknown+…@imported.local`) with display name = subject.
- **Needs policy signature:** if the mapped person has no complete ack (in-app name + signature, **or** admin external override), the reservation is flagged `needsPolicyAck`. Employee sees a banner + ack form; admin sees **Needs policy signature** (and **Unsigned / unknown** when unmapped). Outlook booking alone never counts as signed — they must complete the app ack **or** an admin records that their signed copy was indexed outside this app (**Policy acks → Mark as signed externally**, or **Mark signed externally** on the reservation row).
- **External / admin override:** `POST /api/admin/policy-acks/external` with employee `@boxabl.com` email, printed name (required), optional note/link, optional signed date. Stores `source: "admin_external"` (no signature pad). Clears `needsPolicyAck`. Does **not** email a stamped PDF. Admin list shows badge **External / admin override**.
- **Revoke ack:** `POST /api/admin/policy-acks/revoke` with `{ email, note? }`. Deletes the ack; active bookings get `needsPolicyAck` again; employee must re-sign (or get a new external override). Confirm in Admin UI before revoke.
- Removed Outlook events cancel the linked app reservation (company cancel).

### Stub vs Graph
| `OUTLOOK_SYNC` | Behavior |
|----------------|----------|
| `stub` (default) | Logs create/update/delete/list; reservations still succeed; cron no-ops remote |
| `graph` | Uses `GRAPH_TENANT_ID` / `GRAPH_CLIENT_ID` / `GRAPH_CLIENT_SECRET` to read/write the room calendar. Needs app permission **Calendars.ReadWrite** (application) on `cs1@boxabl.com`. |

Sync is **best-effort** (same idea as policy-ack mail): Outlook failure never blocks a successful reserve/cancel in the app.

### Turn on Graph calendar
1. Entra app registration: application permission `Calendars.ReadWrite` (admin consent); ensure access to room mailbox `cs1@boxabl.com`.
2. `wrangler secret put GRAPH_TENANT_ID` / `GRAPH_CLIENT_ID` / `GRAPH_CLIENT_SECRET` (same secrets as mail).
3. Set `OUTLOOK_SYNC = "graph"` in `wrangler.toml` `[vars]` (and optionally `MAIL_PROVIDER = "graph"`).
4. `npm run deploy`. Smoke: reserve in app → event on cs1; create event on cs1 → Admin **Pull from Outlook** → day board + Needs policy signature if unsigned.

## Admins (seed ∪ extras)

Who counts as admin: **union** of Cloudflare env `ADMIN_EMAILS` (built-in seed) and KV key `admins:extra` (emails added on **Admin → Admins**).

- Built-in seed always stays admin; the UI labels them **Built-in** and will not remove them (change `ADMIN_EMAILS` in Cloudflare / `wrangler.toml` if needed).
- Extra admins must be `@boxabl.com`; only existing admins can add/remove extras.
- `alexis.t@boxabl.com` is on the built-in seed and must stay there.
- Env vars are not writable at runtime — that is why extras live in KV.

## Stack

Cloudflare **Workers** + static `public/` assets, TypeScript, Wrangler, single **KV** namespace (`EV_STORE`) for OTP, sessions, reservations, policy acks, user flags, and extra admins. `MAIL_PROVIDER=stub` returns `previewCode` on the sign-in page (same pattern as Fabulous Tools Hub).

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
  outlook.ts         Room calendar two-way sync (stub|graph)
  graph.ts           Shared Graph token helper
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
3. After verify → `/app.html`. Admins (built-in `ADMIN_EMAILS` or added via Admin → Admins) can open `/admin.html`.
4. First reserve: check policy ack (PDF link), type printed name, draw signature, then book.
5. On each successful policy sign, the app emails **alexis.t@boxabl.com** plus all admins with the **signed policy PDF** attached (stub logs filename + size; Graph sends when `MAIL_PROVIDER=graph`).

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
| `POST` | `/api/admin/policy-acks/external` | Admin: record external signed copy (`email`, `printedName`, optional `externalNote`, `acknowledgedAt`) |
| `POST` | `/api/admin/policy-acks/revoke` | Admin: revoke ack (`email`, optional `note`) — employee must re-sign |
| `GET` | `/api/admin/policy-acks/:email/signed-pdf` | Download stamped policy PDF (admin; in-app signatures only; URL-encode email) |
| `GET` | `/api/admin/admins` | List built-in seed + KV extras |
| `POST` | `/api/admin/admins` | `{ email }` add `@boxabl.com` extra admin |
| `POST` | `/api/admin/admins/remove` | `{ email }` remove KV extra (not built-in) |

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

4. Set `MAIL_PROVIDER = "graph"` and/or `OUTLOOK_SYNC = "graph"` when secrets are ready (or keep stub for smoke).
5. `npm run deploy`
6. Attach hostname when Boss picks the URL. Repo: https://github.com/atorres-gh/boxabl-ev-charging

## Env / vars

| Name | Where | Purpose |
|------|--------|---------|
| `SESSION_SECRET` | secret / `.dev.vars` | Cookie HMAC + OTP salt |
| `ADMIN_EMAILS` | `[vars]` / `.dev.vars` | Built-in admin seed (comma list). Always admin; not removable in UI. Extra admins live in KV `admins:extra` via Admin → Admins tab |
| `ALLOWED_EMAIL_DOMAIN` | vars | Default `boxabl.com` |
| `SPOT_COUNT` | vars | Default `1` |
| `STATION_NAME` | vars | Default `F1 Charge Station` |
| `MAX_SESSION_HOURS` / `BOOK_AHEAD_DAYS` / `GRACE_MINUTES` | vars | Policy knobs |
| `OPEN_HOUR` / `CLOSE_HOUR` / `TIMEZONE` | vars | `6` / `18` / `America/Los_Angeles` |
| `MAIL_PROVIDER` | vars | `stub` \| `graph` |
| `GRAPH_*` | secrets | Live OTP mail + Outlook calendar |
| `OUTLOOK_SYNC` | vars | `stub` \| `graph` (default stub) |
| `OUTLOOK_ROOM_EMAIL` | vars | Default `cs1@boxabl.com` |
| `OUTLOOK_ROOM_NAME` | vars | Default `F1 - Charge Station` |

## Shan handoff — open gaps

1. Real KV namespace ids + Cloudflare login / deploy hostname.
2. Graph mail (or approved SMTP) for production OTP.
3. Holiday calendar if OM wants holidays treated like weekends.
4. Founder/exec priority “bump” notifications (email/Teams) — not in MVP.
5. Enable `OUTLOOK_SYNC=graph` (+ Calendars.ReadWrite on cs1) when Graph secrets are ready; stub is live now.
6. GitHub: https://github.com/atorres-gh/boxabl-ev-charging
