/**
 * This product's business timezone. "Today" / "last N days" boundaries and
 * daily buckets are computed relative to this zone, not the database
 * connection's timezone (UTC — see db.ts, which forces `-c timezone=UTC`).
 * Using bare `current_date` or `::date` on a timestamptz column resolves
 * everything to UTC, which silently shifts every day boundary by up to
 * 5.5 hours for an IST business — e.g. a day with 7 Shopify orders by
 * Shopify's own (IST) clock showed only 5 as "today" on this dashboard,
 * because 2 of those orders landed in the 00:00-05:30 IST window that
 * UTC still considered "yesterday".
 */
export const BUSINESS_TIMEZONE = "Asia/Kolkata";

/**
 * Today's calendar date in the business timezone, as a `date`-typed SQL
 * expression. Use in place of bare `current_date` when comparing against
 * a `date`-typed column (e.g. metric_date).
 */
export const IST_TODAY_DATE = `(now() at time zone '${BUSINESS_TIMEZONE}')::date`;

/**
 * The instant (as a `timestamptz`) marking the start of "today" in the
 * business timezone. Use in place of bare `current_date` when comparing
 * against a `timestamptz`-typed column (e.g. order_date, ordered_at) —
 * comparing a timestamptz against a bare `date` implicitly casts through
 * the session timezone (UTC), not the business timezone.
 */
export const IST_DAY_START = `(date_trunc('day', now() at time zone '${BUSINESS_TIMEZONE}') at time zone '${BUSINESS_TIMEZONE}')`;

/**
 * Casts a `timestamptz` column expression to its calendar day *in the
 * business timezone*, for GROUP BY / day-bucketing. Bare `::date` on a
 * timestamptz casts through the session timezone (UTC) instead, which
 * silently buckets late-night IST orders into the previous day.
 */
export function istDay(column: string): string {
  return `(${column} at time zone '${BUSINESS_TIMEZONE}')::date`;
}
