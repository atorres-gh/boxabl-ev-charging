# Grok Bot prompt — BOXABL EV Charging

Standalone on-site EV reservation app (not a Tools Hub panel). Path: `/workspace/boxabl-ev-charging/`. Repo: https://github.com/atorres-gh/boxabl-ev-charging

Stack: Cloudflare Workers + `public/` static, TypeScript, Wrangler, KV `EV_STORE`. OTP gate mirrors Fabulous Tools Hub (`MAIL_PROVIDER=stub` → `previewCode`). Palette paper `#f4f1ea`, ink `#0b1d36`, navy `#184273`, accent `#ffa400`, Lato body. Plain English UI. Boxabl logo upper left on employee/admin/sign-in.

Station **F1 Charge Station**, `SPOT_COUNT` default 1. `@boxabl.com` only (admin contractor flags). Max 3h, every other business day Mon–Fri, book ≤2 days ahead, hours 6–18 America/Los_Angeles, 15-min grace releasable, cancel / I’m done frees stall. First reserve needs policy ack (checkbox + printed name + drawn signature + version `2026-onsite-ev-v3`). On ack, stamp PDF and email alexis.t@boxabl.com + admins (stub logs; Graph when live). Admin = `ADMIN_EMAILS` seed ∪ KV `admins:extra`.

**Outlook two-way sync** with room `cs1@boxabl.com` / **F1 - Charge Station** (`OUTLOOK_SYNC=stub|graph`). App→Outlook: subject=printed name, location=F1 - Charge Station, no Teams; delete on cancel/done/release. Outlook→App: cron `*/5` calendarView + admin Pull; imports busy blocks; `needsPolicyAck` if no complete app signature (banner + admin badge). Unknown person still shown. Best-effort; never block reserve. Reuses GRAPH_* secrets.

Run: `npm install && cp .dev.vars.example .dev.vars && npm run dev`. Do not invent secrets, do not email anyone, keep `.dev.vars` out of git.
