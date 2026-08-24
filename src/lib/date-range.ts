import type { DateRangeKey } from "@/store/app-context";

const REFERENCE_DATE = new Date("2026-08-21T00:00:00Z");

export function rangeToDays(range: DateRangeKey): number {
  switch (range) {
    case "today":
    case "yesterday":
      return 1;
    case "7d":
      return 7;
    case "30d":
      return 30;
    case "mtd":
      return REFERENCE_DATE.getUTCDate();
    case "ytd": {
      const start = Date.UTC(REFERENCE_DATE.getUTCFullYear(), 0, 1);
      return Math.round((REFERENCE_DATE.getTime() - start) / 86400000) + 1;
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
