# Production Readiness — Requirements and How to Get Them

Status legend:
- ✅ Done in code
- ⏳ Needs input from you (accounts, credentials, decisions)
- 🔧 Needs engineering work (I can do this once the inputs are in)
- 🧪 Needs live verification with a real account

---

## A. Credentials and environment variables

Set these in your hosting provider's environment settings. Never paste them into chat, commit them to git, or put secret values in frontend code.

| Variable | Used by | Status | How to get it |
|---|---|---|---|
| `DATABASE_URL` | Backend | ⏳ | Create a managed Postgres (Supabase, Neon, Render Postgres, or AWS RDS). Copy the connection string. Require SSL. |
| `SUPABASE_URL` | Backend auth (JWKS) | ⏳ | supabase.com → your project → Settings → API → Project URL |
| `SUPABASE_SERVICE_ROLE_KEY` | Backend | ⏳ | Same page → `service_role` key. Server-only, never expose to the browser. |
| `SUPABASE_JWT_SECRET` | Tests only | ✅ | Not needed in production. Real tokens are verified via JWKS. Leave unset in prod. |
| `VITE_SUPABASE_URL` | Frontend login | ⏳ | Same as `SUPABASE_URL` |
| `VITE_SUPABASE_ANON_KEY` | Frontend login | ⏳ | Settings → API → `anon` public key. Safe for the browser. |
| `VITE_API_URL` | Frontend → backend | ⏳ | Your deployed backend URL, for example `https://api.yourdomain.com` |
| `STATE_SIGNING_SECRET` | OAuth state tokens | ⏳ | Generate with `openssl rand -base64 48`. Must differ from other secrets. |
| `CREDENTIAL_ENCRYPTION_KEY` | Encrypts stored API tokens | ⏳ | Generate with `openssl rand -hex 32`. **Back this up in a password manager. If it is lost, every stored connection token becomes unreadable.** |
| `CORS_ORIGIN` | CORS allowlist | ⏳ | Your frontend origin, for example `https://app.yourdomain.com`. Unset means any origin is allowed, which is unsafe in production. |
| `PUBLIC_API_URL` | OAuth redirect URIs | ⏳ | Same as `VITE_API_URL` |
| `FRONTEND_URL` | Post-OAuth redirects | ⏳ | Your deployed frontend URL |
| `PORT` | Server port | ✅ | Defaults to 4000. Most hosts inject this. |
| `SHOPIFY_API_KEY` / `SHOPIFY_API_SECRET` | Shopify OAuth | ⏳ | partners.shopify.com → Apps → Create app → Client credentials. Add redirect URL `{PUBLIC_API_URL}/api/integrations/shopify/callback`. |
| `META_APP_ID` / `META_APP_SECRET` | Meta Ads OAuth | ⏳ | developers.facebook.com → your app → Settings → Basic. Walkthrough given earlier in this chat. |
| `META_LOGIN_CONFIG_ID` | Meta Login for Business | ✅ (optional) | No longer required — the connector falls back to the classic scope-based OAuth dialog (`ads_read`) when unset, which works immediately for any Admin/Developer/Tester on the app. Only set this if you've deliberately created a Configuration (Facebook Login for Business → Configurations) for a public-facing login flow. |
| `GOOGLE_ADS_CLIENT_ID` / `GOOGLE_ADS_CLIENT_SECRET` | Google Ads OAuth | ⏳ | console.cloud.google.com → APIs & Services → Credentials → OAuth client ID (Web application) |
| `GOOGLE_ADS_DEVELOPER_TOKEN` | Google Ads API | ⏳ | Google Ads manager account → Tools → API Center. Requires Google's access approval, which can take days to weeks. |
| Payment provider keys | Billing | ⏳ | See section C, item 1. Depends on the provider you choose. |
| Sentry DSN (optional) | Error tracking | ⏳ | sentry.io → create a Node project → copy the DSN |

Also needed: a `NODE_ENV=production` setting on the host.

---

## B. Accounts and approvals you must complete

| Item | Why | Status | How to do it |
|---|---|---|---|
| Meta Business verification | Required before Meta grants advanced access to ads data for clients other than yourself | ⏳ | business.facebook.com → Business Settings → Security Center → Start verification |
| Meta App Review for `ads_read` | Clients outside your own Meta app's admins can only connect after approval | ⏳ | In your Meta app → App Review → request `ads_read`. Submit a screencast showing the connect flow. |
| Shopify app listing or custom distribution | Needed to install the app on client stores | ⏳ | Partners Dashboard → App distribution. A custom app works for stores you own or are invited to. |
| Google Ads developer token approval | Needed for Google Ads data | ⏳ | Apply from the API Center in your manager account. Basic access is usually enough to start. |
| Shiprocket test account | Needed to verify the Shiprocket connector | ⏳ | Create a test account at shiprocket.in. Use real client credentials during verification. |
| Delhivery account and API token | Needed to verify the Delhivery connector | ⏳ | Sign in at one.delhivery.com. The developer portal is at one.delhivery.com/developer-portal/documents. Generate an API token from the dashboard. |

---

## C. Engineering work remaining in the codebase

Items marked "decision" need an answer from you before I can build them.

1. 🔧 **Real payment gateway (decision needed).** `server/src/integrations/payment-gateway.ts` is a stub. `chargeInvoice` always returns `failed`, so no client can actually be billed. Decision: Razorpay (India, UPI and cards) or Stripe (international). Then I implement subscription creation, invoice charging, cancellation, and signature-verified webhooks. Needs your account and keys. **Still open** — this is the one item explicitly excluded from the 2026-10-13 production-hardening branch, by your own instruction, pending the provider decision.
2. ✅ **Deployment setup.** `server/Dockerfile` + `server/docker-entrypoint.sh` (runs migrations before starting the server) and `.github/workflows/ci.yml` (server tests/typecheck + frontend build/lint on every push) now exist. `docs/DEPLOY.md` documents the actual manual sequence used for the real deploy to `d2c.probild.in` (systemd + nginx — not containerized yet). **Still open:** which hosting provider to containerize on, if you want to move off the current VPS/systemd setup.
3. ✅ **Database migrations are not run automatically — fixed for the container path.** `server/docker-entrypoint.sh` runs `npm run migrate up` before starting the server. For the current non-containerized deploy, `docs/DEPLOY.md` now makes this an explicit, numbered step instead of something only session memory knew about.
4. ✅ **Scheduler assumes one instance — fixed.** A Postgres advisory lock (`pg_try_advisory_lock`, keyed per platform) now wraps `runScheduledSyncs`, so a second process instance's tick is skipped rather than double-running the same syncs.
5. 🔧 **Security hardening — partially done.** ✅ `helmet()` added. ✅ `CORS_ORIGIN` is now mandatory when `NODE_ENV=production` (the server refuses to start without it, verified). **Still open:** request body size limits (Express's 100kb default applies implicitly — never explicitly set or reviewed). **Still open:** the existing rate-limit middleware's configuration was never reviewed or tuned specifically for production traffic volumes.
6. 🔧 **Observability — partially done.** ✅ `console.*` replaced with structured logging (`pino`) in `index.ts` and `scheduler.ts` (deliberately not swept into route files — a separate, larger retrofit). ✅ `/health` now checks the database (`select 1`), returning 503 on failure instead of always 200. **Still open:** request IDs (not added). **Still open:** Sentry (no DSN provided yet, and no hook point was wired in this pass — would need to be added when you have a DSN).
7. 🔧 **Express 4 async error gap — mostly addressed, one known gap remains.** A reusable `asyncHandler` utility exists for future routes (existing routes already handle their own errors correctly). Process-level `unhandledRejection`/`uncaughtException` handlers now log the error and exit the process via a timer in production, so systemd's `Restart=on-failure` brings it back **for errors that happen while the server is already running and serving traffic**. **Known gap, caught in this branch's own final review and not yet fixed:** a fatal error at startup, before anything else is keeping the process alive (e.g., the `CORS_ORIGIN` guard throwing), currently exits with code 0 instead of 1 — the process stops cleanly rather than crashing, so systemd records it as a normal stop and does NOT restart it. The fix is small (restore `process.exitCode = 1` alongside the exit timer in both handlers) but is a real operational risk until it lands — see the production-hardening plan's ledger for the exact ruling.
8. ✅ **Frontend environment documentation.** Root `.env.example` added, documenting `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`, `VITE_API_URL`.
9. 🔧 **Delhivery connector verification.** The endpoint and status-mapping code was written without confirmed API documentation. Your developer portal login lets me check it against the real order-tracking spec. Needs your account. **Still open.**
10. 🔧 **Merchant "unclaimed stores" flow.** A merchant with no dashboard login hits a login wall after completing the Shopify install link, and nothing lists unclaimed stores for agency staff. Decision: needed for launch, or later? **Still open, undecided.**
11. ✅ **Small deferred items — all closed.** `role="alert"` added on load-error paragraphs in `connect-pick-accounts.tsx` and `connect-claim.tsx`. A daily sweep removes expired `pending_connections` rows. Hostile-input tests added for `shop-domain.test.ts`'s `normalizeShopDomain` — independently verified twice over, no impersonation bypass exists. The stray `graphify-out/2026-09-27` snapshot folder was removed, and `.gitignore` now excludes this whole class of dated snapshot folders so it can't recur. The frontend lint count (16 warnings) is unchanged, not newly cleared — fixing the one plan-5-introduced warning properly still means restructuring a data-fetch effect, and remains a nice-to-have, not done.

---

## D. Verification gates before go-live

| Gate | Current state |
|---|---|
| Server type-check (`npx tsc --noEmit`) | ✅ Clean |
| Server test suite | ✅ 386+ passing (grew across plans 5 and the 2026-10-13 hardening branch) |
| Frontend build | ✅ Passes |
| Frontend lint | 🔧 16 warnings (15 pre-existing, 1 added by plan 5 — unchanged) |
| CI (GitHub Actions) | ✅ Runs server tests/typecheck + frontend build/lint on every push, as of the 2026-10-13 branch |
| Docker image build | 🧪 Never run with real Docker (not installed in this dev environment) — verified via equivalent npm-level commands only |
| Real-account end-to-end: Meta connect, pick accounts, data pulls | 🧪 Not yet run |
| Real-account end-to-end: Shopify connect and install-link claim | 🧪 Not yet run |
| Real-account end-to-end: Shiprocket | 🧪 Not yet run |
| Real-account end-to-end: Delhivery | 🧪 Not yet run |
| Real payment flow (sandbox, then live) | 🔧 Blocked on item C1 |
| Load test of the scheduler with realistic client count | 🔧 Not yet run |
| Security review of OAuth state, HMAC verification, and redirect URIs | 🔧 Not yet run |
| `probild-meta-login` (all 5 integration plans) merged onto `probild-live` and deployed to `d2c.probild.in` | ✅ Done |
| `probild-production-hardening` branch merged and deployed | 🔧 Pending your merge/deploy decision |
| Pull request opened against `Probild-in/main` | 🔧 Not yet opened |

---

## E. Decisions only you can make

1. **Payment provider:** Razorpay or Stripe.
2. **Hosting provider and budget.**
3. **Environments:** Do you want a staging environment before production? I recommend yes.
4. **Unclaimed-stores merchant flow (C10):** needed for launch, or after?
5. **Data retention:** How long should synced order, shipment, and campaign data be kept?
6. **Who goes live first:** Which client accounts will you test with first?

---

## How to hand these to me

Send the values for section A in one message, but do not paste the secret values in chat. Instead, set them directly in your hosting provider's environment settings, then tell me which host you chose. Answer the decisions in section E. Once I have access to the deployment target and the answers, I will work through section C in order, then run the verification gates in section D.
