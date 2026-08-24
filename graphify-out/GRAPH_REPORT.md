# Graph Report - orbitd2cdashboard  (2026-08-22)

## Corpus Check
- Corpus is ~30,158 words - fits in a single context window. You may not need a graph.

## Summary
- 457 nodes · 476 edges · 58 communities (35 shown, 23 thin omitted)
- Extraction: 99% EXTRACTED · 1% INFERRED · 0% AMBIGUOUS · INFERRED: 6 edges (avg confidence: 0.75)
- Token cost: 796,693 input · 0 output

## Community Hubs (Navigation)
- Mock Data & Types
- Runtime Dependencies
- Dev Dependencies & Build Tools
- App Routing
- App Entry & Docs
- TypeScript App Config
- App Layout Components
- TypeScript Node Config
- Dropdown Menu Component
- Formatting Utilities
- Sales Page
- Lint Config
- Dialog Component
- Select Component
- Creatives Panel
- All Clients & Geography Pages
- Avatar Component
- Dashboard Page
- Tasks Page
- App Context / Global State
- Manage Clients Page
- Google Ads Page
- Operations Page
- Popover Component
- Tabs Component
- Tooltip Component
- Meta Ads Page
- KPI Card Component
- Badge Component
- Button Component
- Date Range Utilities
- Chart Tooltip Component
- Order Status Badge
- TypeScript Root Config
- Demo Creative 19
- Favicon Link
- Demo Creative 11
- Demo Creative 12
- Demo Creative 13
- Demo Creative 14
- Demo Creative 15
- Demo Creative 16
- Demo Creative 17
- Demo Creative 18
- Demo Creative 20
- Demo Creative 21
- Favicon SVG Asset

## God Nodes (most connected - your core abstractions)
1. `react` - 30 edges
2. `compilerOptions` - 19 edges
3. `compilerOptions` - 15 edges
4. `src/data/mock.ts (seeded pseudo-random mock data layer)` - 12 edges
5. `mulberry32()` - 11 edges
6. `seedFromString()` - 10 edges
7. `Orbit — D2C Analytics & Operations Dashboard` - 9 edges
8. `scripts` - 5 edges
9. `plugins` - 4 edges
10. `generateSalesSeries()` - 4 edges

## Surprising Connections (you probably didn't know these)
- `<title>Orbit</title>` --references--> `Orbit — D2C Analytics & Operations Dashboard`  [INFERRED]
  index.html → README.md
- `/src/main.tsx entry script` --shares_data_with--> `Orbit — D2C Analytics & Operations Dashboard`  [INFERRED]
  index.html → README.md
- `/src/main.tsx entry script` --conceptually_related_to--> `React 19`  [INFERRED]
  index.html → README.md
- `Google Fonts Inter stylesheet link` --conceptually_related_to--> `Tailwind CSS v4 (design token system, OKLCH)`  [INFERRED]
  index.html → README.md

## Import Cycles
- None detected.

## Hyperedges (group relationships)
- **Orbit frontend technology stack** — readme_react19, readme_typescript, readme_vite, readme_tailwindcss, readme_radixui, readme_recharts, readme_reactrouter [EXTRACTED 1.00]
- **Dashboard pages driven by the seeded mock data layer** — readme_src_data_mock, readme_dashboard_page, readme_all_clients_page, readme_shopify_sales_page, readme_operations_rto_page, readme_products_page, readme_geography_page, readme_meta_ads_page, readme_google_ads_page, readme_blended_marketing_page, readme_tasks_page, readme_manage_clients_page [EXTRACTED 1.00]

## Communities (58 total, 23 thin omitted)

### Community 0 - "Mock Data & Types"
Cohesion: 0.07
Nodes (46): CAMPAIGN_NAMES, CITIES, CLIENT_BASE, CLIENTS, COURIERS, CREATIVE_LIBRARY, DEFAULT_CLIENT_ID, FIRST_NAMES (+38 more)

### Community 1 - "Runtime Dependencies"
Cohesion: 0.05
Nodes (39): class-variance-authority, clsx, lucide-react, dependencies, class-variance-authority, clsx, lucide-react, @radix-ui/react-avatar (+31 more)

### Community 2 - "Dev Dependencies & Build Tools"
Cohesion: 0.06
Nodes (30): oxlint, devDependencies, oxlint, tailwindcss, @tailwindcss/vite, @types/node, @types/react, @types/react-dom (+22 more)

### Community 3 - "App Routing"
Cohesion: 0.08
Nodes (12): AllClients, App(), BlendedMarketing, Dashboard, Geography, GoogleAds, ManageClients, MetaAds (+4 more)

### Community 4 - "App Entry & Docs"
Cohesion: 0.08
Nodes (26): Google Fonts Inter stylesheet link, /src/main.tsx entry script, #root mount div, <title>Orbit</title>, All Clients page (agency-level overview table), Blended Marketing page (combined spend, blended ROAS/CAC/CPO), Dashboard page (KPI cards, trend chart, daily summary, alerts), Geography page (state/city breakdown) (+18 more)

### Community 5 - "TypeScript App Config"
Cohesion: 0.08
Nodes (24): DOM, src, vite/client, compilerOptions, allowArbitraryExtensions, allowImportingTsExtensions, erasableSyntaxOnly, jsx (+16 more)

### Community 6 - "App Layout Components"
Cohesion: 0.12
Nodes (11): ClientSelector(), statusDot, DateRangePicker(), ORDER, NAV_GROUPS, NavGroup, NavItem, KIND_META (+3 more)

### Community 7 - "TypeScript Node Config"
Cohesion: 0.10
Nodes (19): node, vite.config.ts, compilerOptions, allowImportingTsExtensions, erasableSyntaxOnly, lib, module, moduleDetection (+11 more)

### Community 8 - "Dropdown Menu Component"
Cohesion: 0.13
Nodes (5): DropdownMenu, DropdownMenuGroup, DropdownMenuRadioGroup, DropdownMenuSub, DropdownMenuTrigger

### Community 9 - "Formatting Utilities"
Cohesion: 0.24
Nodes (4): formatCompact(), formatCurrencyCompact(), inrFormatter, trimZero()

### Community 10 - "Sales Page"
Cohesion: 0.22
Nodes (7): dateFmt, dateFmtLong, getOrderTimeline(), OrderDetailDialog(), STATUS_TONE, TimelineStep, TONE_DOT

### Community 11 - "Lint Config"
Cohesion: 0.22
Nodes (8): plugins, rules, react/only-export-components, react/rules-of-hooks, $schema, oxc, typescript, warn

### Community 12 - "Dialog Component"
Cohesion: 0.22
Nodes (3): Dialog, DialogClose, DialogTrigger

### Community 13 - "Select Component"
Cohesion: 0.22
Nodes (3): Select, SelectGroup, SelectValue

### Community 14 - "Creatives Panel"
Cohesion: 0.29
Nodes (4): Demo Creative 22 (Overhead Man Crossing Road), creativeImageUrl(), CreativeThumbnail(), FORMAT_ICON

### Community 15 - "All Clients & Geography Pages"
Cohesion: 0.25
Nodes (3): react, Input, statusMeta

### Community 16 - "Avatar Component"
Cohesion: 0.32
Nodes (4): colorForName(), initials(), NameAvatar(), PALETTE

### Community 18 - "Tasks Page"
Cohesion: 0.25
Nodes (3): COLUMNS, dateFmt, PRIORITY_VARIANT

### Community 19 - "App Context / Global State"
Cohesion: 0.25
Nodes (5): AppContext, AppContextValue, DATE_RANGE_LABELS, DateRangeKey, Theme

### Community 21 - "Manage Clients Page"
Cohesion: 0.29
Nodes (3): INTEGRATION_ICON, ROLE_VARIANT, statusMeta

### Community 24 - "Popover Component"
Cohesion: 0.40
Nodes (3): Popover, PopoverAnchor, PopoverTrigger

### Community 26 - "Tooltip Component"
Cohesion: 0.40
Nodes (3): Tooltip, TooltipProvider, TooltipTrigger

### Community 30 - "Badge Component"
Cohesion: 0.67
Nodes (3): Badge(), BadgeProps, badgeVariants

### Community 31 - "Button Component"
Cohesion: 0.67
Nodes (3): Button, ButtonProps, buttonVariants

## Knowledge Gaps
- **201 isolated node(s):** `$schema`, `typescript`, `oxc`, `react/rules-of-hooks`, `warn` (+196 more)
  These have ≤1 connection - possible missing edges or undocumented components.
- **23 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `react` connect `All Clients & Geography Pages` to `App Routing`, `App Layout Components`, `Dropdown Menu Component`, `Sales Page`, `Lint Config`, `Dialog Component`, `Select Component`, `Creatives Panel`, `Avatar Component`, `Dashboard Page`, `Tasks Page`, `App Context / Global State`, `Card Component`, `Manage Clients Page`, `Google Ads Page`, `Operations Page`, `Popover Component`, `Tabs Component`, `Tooltip Component`, `Meta Ads Page`, `Products Page`, `KPI Card Component`, `Badge Component`, `Button Component`, `Period Data Hook`, `Blended Marketing Page`?**
  _High betweenness centrality (0.211) - this node is a cross-community bridge._
- **Why does `dependencies` connect `Runtime Dependencies` to `Dev Dependencies & Build Tools`?**
  _High betweenness centrality (0.018) - this node is a cross-community bridge._
- **Why does `plugins` connect `Lint Config` to `All Clients & Geography Pages`?**
  _High betweenness centrality (0.016) - this node is a cross-community bridge._
- **What connects `$schema`, `typescript`, `oxc` to the rest of the system?**
  _201 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `Mock Data & Types` be split into smaller, more focused modules?**
  _Cohesion score 0.06693877551020408 - nodes in this community are weakly interconnected._
- **Should `Runtime Dependencies` be split into smaller, more focused modules?**
  _Cohesion score 0.05128205128205128 - nodes in this community are weakly interconnected._
- **Should `Dev Dependencies & Build Tools` be split into smaller, more focused modules?**
  _Cohesion score 0.06451612903225806 - nodes in this community are weakly interconnected._