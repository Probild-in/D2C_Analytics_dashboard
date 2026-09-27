# Graph Report - orbitd2cdashboard  (2026-09-28)

## Corpus Check
- 163 files · ~132,492 words
- Verdict: corpus is large enough that graph structure adds value.

## Summary
- 974 nodes · 1386 edges · 95 communities (66 shown, 29 thin omitted)
- Extraction: 99% EXTRACTED · 1% INFERRED · 0% AMBIGUOUS · INFERRED: 17 edges (avg confidence: 0.81)
- Token cost: 0 input · 0 output

## Graph Freshness
- Built from commit: `0e93799e`
- Run `git rev-parse HEAD` and compare to check if the graph is stale.
- Run `graphify update .` after code changes (no API cost).

## Community Hubs (Navigation)
- mock.ts
- dependencies
- devDependencies
- App.tsx
- src/data/mock.ts (seeded pseudo-random mock data layer)
- compilerOptions
- topbar.tsx
- compilerOptions
- dropdown-menu.tsx
- utils.ts
- sales.tsx
- plugins
- dialog.tsx
- select.tsx
- creatives-panel.tsx
- react
- avatar.tsx
- dashboard.tsx
- tasks.tsx
- app-context.tsx
- manage-clients.tsx
- google-ads.tsx
- operations.tsx
- popover.tsx
- tabs.tsx
- tooltip.tsx
- meta-ads.tsx
- products.tsx
- index.ts
- badge.tsx
- button.tsx
- date-range.ts
- chart-tooltip.tsx
- status-badge.tsx
- use-period-data.ts
- blended-marketing.tsx
- tsconfig.json
- Demo Creative Placeholder Assets
- /favicon.svg icon link
- Demo Creative 11 - Misty River Landscape Photo
- Demo Creative 12 (Rocky Beach Photo)
- Beach Driftwood Coastline Photo
- Rocky Coastline Stock Photo (demo-14.jpg)
- Demo Creative 15 (Waterfall Nature Shot)
- Demo 16 Coastal Rocky Shore Image
- Demo Creative 17 (Forest Path Photo)
- Demo Creative 18 (Grass Field Nature Shot)
- Demo Creative 20 (Flat Lay Desk Photo)
- Demo Creative 21 - White Heels on Red Splatter
- Favicon (Orbit Icon)
- test-db.ts
- Backend v1: Auth, Billing, and Multi-Platform Integrations
- meta.ts
- dependencies
- devDependencies
- Simple One-Click Integrations: Shopify, Meta, Couriers
- File Structure
- File Structure
- File Structure
- compilerOptions
- Real Platform Integrations: Shopify, Meta Ads, Google Ads
- platforms.ts
- Global Constraints
- all-clients.tsx
- shiprocket.ts
- api.ts
- supabase.ts
- Global Constraints
- google.ts
- connector-registry.ts
- Global Constraints
- delhivery-api.ts
- shopify.ts
- shiprocket-status.ts
- scripts
- delhivery-status.ts
- server/package.json
- state-token.ts
- node-pg-migrate
- tsx
- PaymentGateway
- @types/supertest
- typescript
- @types/cors

## God Nodes (most connected - your core abstractions)
1. `react` - 35 edges
2. `testPool` - 29 edges
3. `resetTestDb()` - 29 edges
4. `signTestJwt()` - 21 edges
5. `pool` - 19 edges
6. `app` - 19 edges
7. `compilerOptions` - 19 edges
8. `encryptToken()` - 16 edges
9. `File Structure` - 16 edges
10. `HttpError` - 15 edges

## Surprising Connections (you probably didn't know these)
- `<title>Orbit</title>` --references--> `Orbit — D2C Analytics & Operations Dashboard`  [INFERRED]
  index.html → README.md
- `Google Fonts Inter stylesheet link` --conceptually_related_to--> `Tailwind CSS v4 (design token system, OKLCH)`  [INFERRED]
  index.html → README.md
- `/src/main.tsx entry script` --shares_data_with--> `Orbit — D2C Analytics & Operations Dashboard`  [INFERRED]
  index.html → README.md
- `/src/main.tsx entry script` --conceptually_related_to--> `React 19`  [INFERRED]
  index.html → README.md
- `insertConnection()` --calls--> `encryptToken()`  [EXTRACTED]
  server/test/integrations/delhivery.test.ts → server/src/lib/crypto.ts

## Import Cycles
- None detected.

## Hyperedges (group relationships)
- **Dashboard pages driven by the seeded mock data layer** — readme_src_data_mock, readme_dashboard_page, readme_all_clients_page, readme_shopify_sales_page, readme_operations_rto_page, readme_products_page, readme_geography_page, readme_meta_ads_page, readme_google_ads_page, readme_blended_marketing_page, readme_tasks_page, readme_manage_clients_page [EXTRACTED 1.00]
- **Orbit frontend technology stack** — readme_react19, readme_typescript, readme_vite, readme_tailwindcss, readme_radixui, readme_recharts, readme_reactrouter [EXTRACTED 1.00]

## Communities (95 total, 29 thin omitted)

### Community 0 - "mock.ts"
Cohesion: 0.07
Nodes (40): CAMPAIGN_NAMES, CITIES, CLIENT_BASE, CLIENTS, COURIERS, DEFAULT_CLIENT_ID, FIRST_NAMES, generateSalesSeries() (+32 more)

### Community 1 - "dependencies"
Cohesion: 0.05
Nodes (41): class-variance-authority, clsx, lucide-react, dependencies, class-variance-authority, clsx, lucide-react, @radix-ui/react-avatar (+33 more)

### Community 2 - "devDependencies"
Cohesion: 0.06
Nodes (30): oxlint, devDependencies, oxlint, tailwindcss, @tailwindcss/vite, @types/node, @types/react, @types/react-dom (+22 more)

### Community 3 - "App.tsx"
Cohesion: 0.07
Nodes (13): AllClients, App(), BlendedMarketing, Dashboard, Geography, GoogleAds, Login, ManageClients (+5 more)

### Community 4 - "src/data/mock.ts (seeded pseudo-random mock data layer)"
Cohesion: 0.08
Nodes (26): Google Fonts Inter stylesheet link, /src/main.tsx entry script, #root mount div, <title>Orbit</title>, All Clients page (agency-level overview table), Blended Marketing page (combined spend, blended ROAS/CAC/CPO), Dashboard page (KPI cards, trend chart, daily summary, alerts), Geography page (state/city breakdown) (+18 more)

### Community 5 - "compilerOptions"
Cohesion: 0.08
Nodes (24): DOM, vite/client, compilerOptions, allowArbitraryExtensions, allowImportingTsExtensions, erasableSyntaxOnly, jsx, lib (+16 more)

### Community 6 - "topbar.tsx"
Cohesion: 0.12
Nodes (11): ClientSelector(), statusDot, DateRangePicker(), ORDER, NAV_GROUPS, NavGroup, NavItem, KIND_META (+3 more)

### Community 7 - "compilerOptions"
Cohesion: 0.10
Nodes (19): node, vite.config.ts, compilerOptions, allowImportingTsExtensions, erasableSyntaxOnly, lib, module, moduleDetection (+11 more)

### Community 8 - "dropdown-menu.tsx"
Cohesion: 0.13
Nodes (5): DropdownMenu, DropdownMenuGroup, DropdownMenuRadioGroup, DropdownMenuSub, DropdownMenuTrigger

### Community 9 - "utils.ts"
Cohesion: 0.24
Nodes (4): formatCompact(), formatCurrencyCompact(), inrFormatter, trimZero()

### Community 10 - "sales.tsx"
Cohesion: 0.18
Nodes (9): dateFmt, dateFmtLong, EMPTY_ORDERS, EMPTY_PRODUCTS, getOrderTimeline(), OrderDetailDialog(), STATUS_TONE, TimelineStep (+1 more)

### Community 11 - "plugins"
Cohesion: 0.22
Nodes (8): plugins, rules, react/only-export-components, react/rules-of-hooks, $schema, oxc, typescript, warn

### Community 12 - "dialog.tsx"
Cohesion: 0.22
Nodes (3): Dialog, DialogClose, DialogTrigger

### Community 13 - "select.tsx"
Cohesion: 0.22
Nodes (3): Select, SelectGroup, SelectValue

### Community 14 - "creatives-panel.tsx"
Cohesion: 0.29
Nodes (6): Demo Creative 22 (Overhead Man Crossing Road), creativeImageUrl(), CreativeThumbnail(), formatIcon(), isCarouselFormat(), isVideoFormat()

### Community 15 - "react"
Cohesion: 0.17
Nodes (5): react, accentMap, KpiCardProps, Input, EMPTY_GEO

### Community 16 - "avatar.tsx"
Cohesion: 0.32
Nodes (4): colorForName(), initials(), NameAvatar(), PALETTE

### Community 18 - "tasks.tsx"
Cohesion: 0.18
Nodes (5): COLUMNS, dateFmt, EMPTY_TASKS, EMPTY_TEAM, PRIORITY_VARIANT

### Community 19 - "app-context.tsx"
Cohesion: 0.25
Nodes (5): AppContext, AppContextValue, DATE_RANGE_LABELS, DateRangeKey, Theme

### Community 21 - "manage-clients.tsx"
Cohesion: 0.18
Nodes (8): clearConnectionResultFromUrl(), ConnectionResult, ConnectionResultBanner(), EMPTY_TEAM, INTEGRATION_ICON, readConnectionResult(), ROLE_VARIANT, statusMeta

### Community 22 - "google-ads.tsx"
Cohesion: 0.22
Nodes (5): ACTIVITY_ICON, EMPTY_CAMPAIGNS, EMPTY_CREATIVES, EMPTY_NOTES, STATUS_VARIANT

### Community 23 - "operations.tsx"
Cohesion: 0.22
Nodes (5): dateFmt, EMPTY_GEO, EMPTY_ORDERS, EMPTY_SUMMARY, STATUS_FLOW

### Community 24 - "popover.tsx"
Cohesion: 0.40
Nodes (3): Popover, PopoverAnchor, PopoverTrigger

### Community 26 - "tooltip.tsx"
Cohesion: 0.40
Nodes (3): Tooltip, TooltipProvider, TooltipTrigger

### Community 27 - "meta-ads.tsx"
Cohesion: 0.25
Nodes (5): ACTIVITY_ICON, EMPTY_CAMPAIGNS, EMPTY_CREATIVES, EMPTY_NOTES, STATUS_VARIANT

### Community 29 - "index.ts"
Cohesion: 0.07
Nodes (42): pool, allowedOrigins, stubPaymentGateway, assertClientAccess(), getAccessibleClientIds(), resolveClientScope(), saveConnection(), SaveConnectionInput (+34 more)

### Community 30 - "badge.tsx"
Cohesion: 0.67
Nodes (3): Badge(), BadgeProps, badgeVariants

### Community 31 - "button.tsx"
Cohesion: 0.67
Nodes (3): Button, ButtonProps, buttonVariants

### Community 36 - "use-period-data.ts"
Cohesion: 0.47
Nodes (3): useClientResource(), EMPTY_SALES, usePeriodData()

### Community 58 - "test-db.ts"
Cohesion: 0.10
Nodes (21): app, decryptToken(), encryptToken(), getKey(), expectedTables, FAKE_COURIER_PLATFORM, installFakeCourier(), __dirname (+13 more)

### Community 59 - "Backend v1: Auth, Billing, and Multi-Platform Integrations"
Cohesion: 0.06
Nodes (34): Backend Foundation Implementation Plan, File Structure, Global Constraints, Task 10: Courier picker scaffold, Task 11: Provision Supabase and connect the frontend, Task 1: Scaffold the server project, Task 2: Database schema migration, Task 3: Supabase Auth JWT verification middleware (+26 more)

### Community 60 - "meta.ts"
Cohesion: 0.22
Nodes (3): MetaAd, MetaCampaign, MetaInsightRow

### Community 61 - "dependencies"
Cohesion: 0.13
Nodes (15): cors, dotenv, express, jose, jsonwebtoken, node-cron, pg, dependencies (+7 more)

### Community 62 - "devDependencies"
Cohesion: 0.13
Nodes (15): devDependencies, supertest, @types/express, @types/jsonwebtoken, @types/node, @types/node-cron, @types/pg, vitest (+7 more)

### Community 63 - "Simple One-Click Integrations: Shopify, Meta, Couriers"
Cohesion: 0.08
Nodes (23): Architecture, Connector framework, Courier status mapping, Courier sync, Data model (migration 006), Delhivery (plan 3), Error handling, Findings from current provider docs (Context7, 2026-09-27) (+15 more)

### Community 64 - "File Structure"
Cohesion: 0.10
Nodes (19): File Structure, Global Constraints, Shopify Integration Implementation Plan, Task 10: `GET /api/clients/:id/products`, Task 11: `GET /api/clients/:id/geography`, Task 12: Shared frontend fetch hook, Task 13: Rewire `usePeriodData` to real sales data, Task 14: Rewire Sales, Products, Geography, Operations pages (+11 more)

### Community 65 - "File Structure"
Cohesion: 0.13
Nodes (14): File Structure, Global Constraints, Meta Ads Integration Implementation Plan, Task 10: Connect Meta Ads UI, Task 1: Migration — campaigns, campaign_creatives, campaign_notes, Task 2: Meta connector — getAuthUrl, handleCallback, account-limit enforcement, Task 3: Register the Meta connector; add META_APP_ID/META_APP_SECRET, Task 4: Meta connector sync — campaigns, insights, creatives (+6 more)

### Community 66 - "File Structure"
Cohesion: 0.15
Nodes (12): File Structure, Global Constraints, Google Ads Integration Implementation Plan, Task 1: Fix campaigns.ts's results/conversions column-name and resultType bugs, Task 2: Google connector — getAuthUrl, handleCallback, account-limit enforcement, Task 3: Register the Google connector; add env vars, Task 4: Real token refresh on 401, Task 5: Full sync — campaigns, daily metrics, ads as creatives (+4 more)

### Community 67 - "compilerOptions"
Cohesion: 0.15
Nodes (12): compilerOptions, esModuleInterop, module, moduleResolution, outDir, resolveJsonModule, rootDir, skipLibCheck (+4 more)

### Community 68 - "Real Platform Integrations: Shopify, Meta Ads, Google Ads"
Cohesion: 0.17
Nodes (11): Architecture, Connect flow — per-platform specifics, Data model additions, Error handling, Goal, Non-goals, Real Platform Integrations: Shopify, Meta Ads, Google Ads, Rollout: one spec, three plans (+3 more)

### Community 69 - "platforms.ts"
Cohesion: 0.24
Nodes (11): CredentialsDialog(), IntegrationCard(), STATUS_BADGE, EMPTY_CONNECTIONS, IntegrationsPanel(), Connection, CredentialField, pickConnection() (+3 more)

### Community 70 - "Global Constraints"
Cohesion: 0.18
Nodes (10): Global Constraints, Integrations Framework (Plan 1 of 5) Implementation Plan, Task 1: Migration 006 — `courier_shiprocket` platform + `credentials` column, Task 2: `Connector` discriminated union, `authType` guards, fake-courier test helper, Task 3: Forgiving Shopify store-name input (server-side normalizer), Task 4: Per-user rate limiter middleware, Task 5: `saveConnection` helper, credentials `/connect` route, `DELETE` disconnect route, Task 6: Frontend API helper and platform metadata (+2 more)

### Community 71 - "all-clients.tsx"
Cohesion: 0.40
Nodes (3): ClientSummary, EMPTY_SUMMARY, statusMeta

### Community 72 - "shiprocket.ts"
Cohesion: 0.25
Nodes (13): asDate(), asString(), fetchOrdersPage(), isRecord(), parseOrder(), parseShipment(), ShiprocketAuthError, shiprocketLogin() (+5 more)

### Community 78 - "Global Constraints"
Cohesion: 0.15
Nodes (12): Global Constraints, Shiprocket + Shipments + Operations (Plan 2 of 5) Implementation Plan, Task 10: Final verification, real-account checklist, graph refresh, Task 1: Harden `/connect` logging and clear secrets on disconnect, Task 2: Rate limiter — per-user bucket and key eviction, Task 3: Migration 007 — `shipments` table, Task 4: Shiprocket status mapper and API client, Task 5: Shiprocket connector, registry, couriers list, scheduler (+4 more)

### Community 79 - "google.ts"
Cohesion: 0.19
Nodes (9): getDeveloperToken(), getOAuthCredentials(), GoogleAdRow, GoogleCampaignRow, googleConnector, GoogleMetricsRow, refreshAccessToken(), runGaqlQuery() (+1 more)

### Community 80 - "connector-registry.ts"
Cohesion: 0.19
Nodes (8): delhiveryConnector, TERMINAL_STATUSES, metaConnector, shopifyConnector, Connector, CredentialsConnector, CredentialsRejectedError, insertConnection()

### Community 81 - "Global Constraints"
Cohesion: 0.20
Nodes (9): Delhivery Integration (Plan 3 of 5) Implementation Plan, Global Constraints, Task 1: Migration 009 — Shopify tracking-number columns, Task 2: Capture Shopify's tracking number and company during sync, Task 3: Delhivery status mapper and API client (explicitly unsourced), Task 4: Delhivery connector, registry, couriers list, scheduler, Task 5: Route-level test through the real Delhivery connector, Task 6: Frontend — add Delhivery to the Integrations panel (+1 more)

### Community 82 - "delhivery-api.ts"
Cohesion: 0.33
Nodes (6): asString(), DelhiveryAuthError, DelhiveryTrackedShipment, isRecord(), trackShipment(), TRACK_FIXTURE

### Community 83 - "shopify.ts"
Cohesion: 0.13
Nodes (3): ShopifyOrder, BaseConnector, OAuthConnector

### Community 84 - "shiprocket-status.ts"
Cohesion: 0.33
Nodes (5): DISPATCHED_EXACT, DISPATCHED_PARTS, IN_TRANSIT_PARTS, mapShiprocketStatus(), ShipmentStatus

### Community 85 - "scripts"
Cohesion: 0.33
Nodes (6): scripts, build, dev, migrate, start, test

### Community 86 - "delhivery-status.ts"
Cohesion: 0.40
Nodes (4): DISPATCHED_PARTS, IN_TRANSIT_PARTS, mapDelhiveryStatus(), ShipmentStatus

### Community 87 - "server/package.json"
Cohesion: 0.40
Nodes (4): name, private, type, version

### Community 88 - "state-token.ts"
Cohesion: 0.60
Nodes (4): getSecret(), signState(), StatePayload, verifyState()

## Knowledge Gaps
- **433 isolated node(s):** `$schema`, `typescript`, `oxc`, `react/rules-of-hooks`, `warn` (+428 more)
  These have ≤1 connection - possible missing edges or undocumented components.
- **29 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `react` connect `react` to `App.tsx`, `topbar.tsx`, `dropdown-menu.tsx`, `sales.tsx`, `plugins`, `dialog.tsx`, `select.tsx`, `creatives-panel.tsx`, `avatar.tsx`, `dashboard.tsx`, `tasks.tsx`, `app-context.tsx`, `card.tsx`, `manage-clients.tsx`, `google-ads.tsx`, `operations.tsx`, `popover.tsx`, `tabs.tsx`, `tooltip.tsx`, `meta-ads.tsx`, `products.tsx`, `badge.tsx`, `button.tsx`, `use-period-data.ts`, `platforms.ts`, `all-clients.tsx`?**
  _High betweenness centrality (0.188) - this node is a cross-community bridge._
- **Why does `pool` connect `index.ts` to `shiprocket.ts`, `google.ts`, `connector-registry.ts`, `shopify.ts`, `test-db.ts`, `meta.ts`?**
  _High betweenness centrality (0.018) - this node is a cross-community bridge._
- **Why does `plugins` connect `plugins` to `react`?**
  _High betweenness centrality (0.008) - this node is a cross-community bridge._
- **What connects `$schema`, `typescript`, `oxc` to the rest of the system?**
  _433 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `mock.ts` be split into smaller, more focused modules?**
  _Cohesion score 0.06765327695560254 - nodes in this community are weakly interconnected._
- **Should `dependencies` be split into smaller, more focused modules?**
  _Cohesion score 0.04878048780487805 - nodes in this community are weakly interconnected._
- **Should `devDependencies` be split into smaller, more focused modules?**
  _Cohesion score 0.06451612903225806 - nodes in this community are weakly interconnected._