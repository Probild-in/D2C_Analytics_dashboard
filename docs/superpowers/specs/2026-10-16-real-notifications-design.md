# Real Notifications Design

## Goal

Replace the dashboard's "Notifications" bell menu — currently a hardcoded, scripted list
of fake events read from `src/data/mock.ts` (`getNotifications()`) — with real
notifications generated from real signals already (or newly) computed in this app, and
delivered live to the browser.

## Context

Today, `src/components/layout/notifications-menu.tsx` imports `getNotifications` from
`src/data/mock.ts`, which returns a fixed, deterministically-seeded script of 9
notifications with fabricated timestamps anchored to a frozen date. There is no backend
route, no database table, and no generation logic for notifications anywhere in this
codebase.

Of the 7 notification kinds the mock data shows, the real data backing each varies
widely:

- **Task assigned / task completed** — real data already exists. `crm_tasks` (via
  `server/src/routes/tasks.ts`) has real `assignee_id`, `status`, and timestamps. No new
  detection logic needed — these are generated synchronously, inside the existing
  create/update-status routes.
- **RTO alert** — real data exists, but no alerting logic. `server/src/routes/clients.ts`
  already computes `rtoPercent` per client and classifies it with `statusFromRtoPercent`
  (≥15% critical, ≥8% attention, else healthy) — this spec reuses those exact bands
  rather than inventing new ones.
- **Sales dip, Ad spend anomaly, Blended ROAS below target** — the underlying raw data
  (orders, ad spend, net sales) exists, but no app anywhere defines what counts as a
  "dip," an "anomaly," or a "target." This spec proposes concrete definitions (below).
  Blended ROAS specifically must match the dashboard's own definition — `net sales / ad
  spend` (`src/hooks/use-period-data.ts`'s `blendedRoas`), **not** the per-campaign
  `revenue / spend` figure `server/src/routes/campaigns.ts` reports — since that's what
  "Blended ROAS" means everywhere else in this app the term appears. This calculation
  currently only exists in the frontend hook; it needs a server-side equivalent to be
  checked by a cron job.
- **Campaign feedback** — no real feature exists to back this at all (no comment system
  on campaigns anywhere in the app). **Out of scope for this spec** — see below.
- **System** (e.g. "weekly summary ready") — not tied to any real per-client signal in
  this app today. **Out of scope for this spec** — see below.

## Explicitly out of scope

- **Campaign feedback notifications.** Building a comment/feedback system on campaigns is
  its own feature, not a side effect of making notifications real. If wanted later, it
  gets its own brainstorm.
- **System notifications** (e.g. "weekly summary ready") — no real weekly-summary feature
  exists to generate this from. Can be added later once/if such a feature exists.
- Per-client/per-user configurable thresholds (dip %, anomaly %, ROAS target) — v1 ships
  with one fixed default per metric, applied to every client. Making these configurable
  is a natural, clearly-separable follow-up, not required for "real instead of fake."
- Notification preferences/muting, email/push-to-phone delivery, digest emails — all out
  of scope; this is the in-app bell menu only.
- Horizontal scaling of the SSE layer (multiple backend processes needing to share
  connection state via Redis pub/sub or similar) — this app runs as a single `systemd`
  process on one host today (`docs/DEPLOY.md`); if that changes, the SSE broadcast
  mechanism (an in-process `EventEmitter`, see Architecture) will need revisiting then,
  not now.

## Architecture

### Data model

```sql
create table notifications (
  id uuid primary key default gen_random_uuid(),
  client_id text not null references clients(id) on delete cascade,
  kind text not null check (kind in ('rto', 'sales', 'ads', 'roas', 'task')),
  title text not null,
  description text not null,
  created_at timestamptz not null default now()
);

-- Per-staff-member read state. A notification is unread for a given team member until
-- they have a row here; staff with all_client_access and self-serve owners both only
-- ever see notifications for clients they're scoped to (same access-scoping as every
-- other route in this app).
create table notification_reads (
  notification_id uuid not null references notifications(id) on delete cascade,
  team_member_id uuid not null references team_members(id) on delete cascade,
  read_at timestamptz not null default now(),
  primary key (notification_id, team_member_id)
);

create index notifications_client_id_created_at_idx on notifications (client_id, created_at desc);
```

`kind` is `'rto' | 'sales' | 'ads' | 'roas' | 'task'` — the 5 real kinds from this spec's
scope (not the mock's 7).

### Generating notifications

**Task assigned / task completed** (`kind = 'task'`): inserted synchronously inside
`tasks.ts`'s existing `POST /` (on create, "Task assigned to {assignee}") and `PATCH
/:taskId` (on transition to `'Completed'`, "Task completed: {title}") handlers — no new
job, no new timing, just one more `INSERT` alongside the existing task write.

**RTO alert, Sales dip, Ad spend anomaly, Blended ROAS below target** (`kind = 'rto' |
'sales' | 'ads' | 'roas'`): one new cron job, `server/src/jobs/notification-checks.ts`,
registered in `scheduler.ts` **once daily**, shortly after IST midnight (e.g. `15 0 * * *`
— 00:15 IST, after the day has fully rolled over per this app's existing
`BUSINESS_TIMEZONE`/`IST_DAY_START` convention in `server/src/lib/sql-dates.ts`), checking
**yesterday's now-complete data**, not partial "today" data. This is a deliberate
correction from an earlier draft of this design that checked every 15 minutes against
partial same-day totals — comparing a partial day against a complete one from last week
would produce a false "dip"/"anomaly" on every single run before the day ends, since
today's count is naturally behind until midnight. Checking once daily against a complete
prior day is less "instant" than every-15-minutes but is the version that's actually
*correct*; task notifications (below) remain instant regardless, since they're inserted
synchronously on the real event, not computed from a rolling window. For each client,
each run, using yesterday (IST) as the window:

- **RTO**: yesterday's `rtoPercent` using the existing `ORDER_RTO_CTES_SINGLE_CLIENT` CTE
  (`server/src/lib/rto-status.ts`, scoped to yesterday's date range), classified with the
  existing 8%/15% bands. Alert only when the *computed band* is `attention` or `critical`.
- **Sales dip**: yesterday's order count vs. the same weekday one week before yesterday;
  alert when down ≥20%. Skip (no alert, not a 0% "dip") if last week's comparison day had
  zero orders — nothing to meaningfully compare against.
- **Ad spend anomaly**: yesterday's combined Meta+Google spend vs. the trailing 7-day
  daily average (the 7 complete days before yesterday); alert when it differs by ≥25% in
  either direction.
- **Blended ROAS**: yesterday's `net sales / ad spend` (matching `use-period-data.ts`'s
  formula, computed server-side from `shopify_orders` + `meta_campaign_metrics` +
  `google_campaign_metrics`); alert when below `3.0` (hardcoded default target for v1, per
  "Explicitly out of scope" above). Skip (no alert) if yesterday's ad spend was `0` —
  matching the dashboard's own `sum.adSpend > 0 ? ... : 0` guard, not a false "0x ROAS."

**De-duplication (all 4 threshold-based kinds):** before inserting, check whether a
notification of that same `kind` for that same `client_id` already exists with
`created_at > now() - interval '20 hours'` (shorter than the 24h run cadence on purpose,
so a cron run that's slightly early/late one day never silently skips — but long enough
that a manual re-run or a double-fire doesn't duplicate the same day's alert). This is a
simple cooldown, not a stateful "did the band change" tracker — a client stuck in
`critical` RTO for 3 days straight gets re-alerted once per day, not just once ever. (A
more precise "alert only on a state *transition*," e.g. healthy→attention, is a
reasonable future refinement, not required for v1 — noting this so it isn't silently
assumed to be band-transition logic.)

### Delivery

**`GET /api/notifications`** — returns the caller's visible notifications (scoped via the
existing `getAccessibleClientIds`/`isStaffMember` pattern), each with a `read: boolean`
computed via a `left join notification_reads ... where team_member_id = $caller or
read_at is not null`, most recent first, capped at (e.g.) 50.

**`POST /api/notifications/:id/read`** — inserts into `notification_reads` for the caller
(idempotent via `on conflict do nothing` on the composite primary key).

**`GET /api/notifications/stream`** — a Server-Sent Events endpoint. Kept open per
authenticated session; the server pushes a small JSON payload (`{ type: "notification",
notification: {...} }`) the moment a new row is inserted for a client the caller can see.
Implemented with a simple in-process `EventEmitter` (`server/src/lib/notification-bus.ts`)
that every insert path (the task routes, the cron job) calls `.emit(clientId,
notification)` on; the stream route subscribes/unsubscribes per connection. SSE, not
WebSocket — this is one-directional (server → client only), works over plain HTTP with no
new protocol or client library, and the browser's native `EventSource` reconnects
automatically on drop.

**Auth note:** the browser's native `EventSource` API cannot send a custom `Authorization`
header, and this app has no cookie-based session to fall back on (Supabase JWTs via
Bearer header only, everywhere else). Rather than invent a token-in-URL auth path (a real
risk — JWTs in URLs can leak via proxy/access logs), the frontend will **not** use the
native `EventSource` object; it will use `fetch` with the normal `Authorization` header
and read the response body as a stream (`response.body.getReader()`), manually parsing
the `text/event-stream` format line-by-line. This is a few more lines of frontend code
than `new EventSource(url)` would be, but keeps this endpoint on the exact same auth
mechanism as every other request in this app, with no special-casing.

### Frontend

`notifications-menu.tsx` drops the `mock.ts` import. On mount: `GET /api/notifications`
once to populate the initial list, then opens the `fetch`-based stream (above) and
prepends any new notification as it arrives. "Mark all read" and per-item click both call
`POST /api/notifications/:id/read` for real (currently purely local `useState`).
`relativeTime()` (currently anchored to a frozen reference date) is fixed to use the real
current time — this was a leftover of the mock data's fixed "today," not something to
carry forward.

## Testing

- Backend: unit tests for each threshold function (RTO/sales-dip/ad-spend-anomaly/ROAS)
  against constructed data proving the exact boundary (e.g. a 19% dip does not alert, a
  20% dip does); integration tests for the cron job's de-duplication window; integration
  tests for `tasks.ts`'s two new insert points; integration tests for the 3 new routes
  (including the staff/self-serve access-scoping, reusing the pattern proven in the SaaS
  signup plan's final review); an SSE test that asserts a notification inserted via one
  request is observable on an open stream for an authorized client, and NOT observable on
  a stream for a client the caller can't access.
- Frontend: no automated test harness exists in this repo (established precedent from
  every other frontend task this session) — `npm run build` is the verification bar, plus
  manual verification of the stream actually updating live in a browser.

## Review Focus

- A client with no shipments/couriers connected yet must not crash the RTO check (the
  existing `has_shipments` CTE already handles a client with zero shipments; this job
  reuses that path verbatim rather than re-deriving it).
- A client with no ad spend at all (not yet connected to Meta/Google) must not produce a
  divide-by-zero false "ROAS below target" or "ad spend anomaly" alert — both checks must
  skip (not alert 0 < 3.0) when `adSpend = 0` for that client, matching the dashboard's
  own `sum.adSpend > 0 ? ... : 0` guard pattern.
- A brand-new client with no sales history 7 days ago must not produce a false "sales dip"
  (division by zero / comparing against nothing) — skip the check if last week's same-day
  order count is 0.
- An SSE connection must not leak a client's notifications to a session that loses access
  to that client mid-stream (e.g. a team member's scope is edited) — per-connection access
  is checked at connect time, matching this app's existing all-other-routes behavior
  (not polled live during the connection's lifetime); this is a known, acceptable
  staleness window (same class as any other access-scoping check in this app, none of
  which re-verify mid-request either), not a gap introduced by this feature.
- A self-serve owner (vs. agency staff) must see only their own client's notifications,
  not the agency-wide feed — reuses the `isStaffMember` pattern proven in the SaaS signup
  final review.
