import type { DateRangeKey } from "@/store/app-context";

// This business's reporting day is India's, regardless of the viewer's own browser
// timezone (see server/src/lib/sql-dates.ts, which anchors the backend's "today"
// the same way). Returns "now" shifted so its UTC getters read out IST wall-clock
// values — the same trick used for the IST-boundary regression tests on the server.
const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
function nowInBusinessTimezone(): Date {
  return new Date(Date.now() + IST_OFFSET_MS);
}

export function rangeToDays(range: DateRangeKey): number {
  switch (range) {
    case "today":
    case "yesterday":
      return 1;
    // Shopify's own "N days" quick filters on the Orders page (and presumably its other
    // period chips) actually span N+1 calendar days — today plus N full days before it,
    // not N days inclusive of today. Confirmed empirically for "7 days": Shopify's own
    // order-count API for an 8-day window (today + 7 prior days) returns exactly what
    // its UI shows, while a literal 7-day window returns fewer. Matched here so this
    // dashboard's numbers line up with what merchants already see in Shopify.
    case "7d":
      return 8;
    case "30d":
      return 31;
    case "mtd":
      // Elapsed days so far this month, IST. Previously pinned to a frozen mock
      // reference date (2026-08-21, shared with src/data/mock.ts's demo data) that
      // never tracked the real date once this view started querying real synced
      // data — every day since has requested the wrong number of days.
      return nowInBusinessTimezone().getUTCDate();
    case "ytd": {
      const now = nowInBusinessTimezone();
      const start = Date.UTC(now.getUTCFullYear(), 0, 1);
      return Math.round((now.getTime() - start) / 86400000) + 1;
    }
    case "custom":
      return 30;
    default:
      return 30;
  }
}

export function percentDelta(current: number, previous: number) {
  if (previous === 0) return current === 0 ? 0 : 100;
  return ((current - previous) / previous) * 100;
}
