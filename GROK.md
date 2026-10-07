# Grok Bot prompt — BOXABL EV Charging

Standalone on-site EV reservation app (not a Tools Hub panel). Path: `/workspace/boxabl-ev-charging/`.

Stack: Cloudflare Workers + `public/` static, TypeScript, Wrangler, KV `EV_STORE`. OTP gate mirrors Fabulous Tools Hub (`MAIL_PROVIDER=stub` → `previewCode`). Palette paper `#f4f1ea`, ink `#0b1d36`, navy `#184273`, accent `#ffa400`, Lato body. Plain English UI.

Station **F1 Charge Station**, `SPOT_COUNT` default 1. `@boxabl.com` only (admin contractor flags). Max 3h, every other business day Mon–Fri, book ≤2 days ahead, hours 6–18 America/Los_Angeles, 15-min grace releasable, cancel / I’m done frees stall. First reserve needs policy ack (checkbox + printed name + drawn signature + stored timestamp/email/version `2026-onsite-ev-v3` on new signs) linking `public/BOXABL-EV-Charging-Policy.pdf`. Existing complete name+sig acks stay valid (no forced re-sign). On each successful ack, stamp name/signature/date onto the policy PDF and email alexis.t@boxabl.com + ADMIN_EMAILS with that PDF attached (stub logs filename+bytes; Graph fileAttachment when live). Admin via `ADMIN_EMAILS`: list, release, override, flags, policy acks, download signed PDF (rebuilds stamped policy from KV name/sig).

Run: `npm install && cp .dev.vars.example .dev.vars && npm run dev`. Do not invent secrets, do not email anyone, do not create GitHub remotes, do not deploy unless wrangler is logged in and secrets/KV are ready.
