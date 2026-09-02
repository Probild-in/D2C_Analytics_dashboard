import * as React from "react";
import { useApp } from "@/store/app-context";
import { rangeToDays } from "@/lib/date-range";
import { getAllClientsSalesSeries, sumSeries } from "@/data/mock";
import { useClientResource } from "./use-client-resource";
import type { SalesPoint } from "@/data/types";

// Hoisted so useClientResource's fallback param is referentially stable across renders
// (see Task 12's review note on the hook's [path]-only effect deps) — not required for
// correctness with an empty array specifically, but keeps every call site consistent.
const EMPTY_SALES: SalesPoint[] = [];

export function usePeriodData() {
  const { clientId, isAllClients, dateRange } = useApp();
  const days = rangeToDays(dateRange);

  const salesPath = !isAllClients && clientId ? `/api/clients/${clientId}/sales?days=${days * 2}` : null;
  const { data: realSeries, loading } = useClientResource<SalesPoint[]>(salesPath, EMPTY_SALES);

  return React.useMemo(() => {
    const total = isAllClients ? getAllClientsSalesSeries(days * 2) : realSeries;
    const current = total.slice(days);
    const previous = total.slice(0, days);
    return {
      days,
      current,
      previous,
      currentSum: sumSeries(current),
      previousSum: sumSeries(previous),
      loading,
    };
  }, [isAllClients, days, realSeries, loading]);
}

export function deriveMetrics(sum: ReturnType<typeof sumSeries>) {
  const aov = sum.orders > 0 ? sum.netSales / sum.orders : 0;
  const codPercent = sum.orders > 0 ? (sum.codOrders / sum.orders) * 100 : 0;
  const prepaidPercent = sum.orders > 0 ? (sum.prepaidOrders / sum.orders) * 100 : 0;
  const cancellationPercent = sum.orders > 0 ? (sum.cancelledOrders / sum.orders) * 100 : 0;
  const rtoPercent = sum.orders > 0 ? (sum.rtoOrders / sum.orders) * 100 : 0;
  const blendedRoas = sum.adSpend > 0 ? sum.netSales / sum.adSpend : 0;
  const costPerOrder = sum.orders > 0 ? sum.adSpend / sum.orders : 0;
  const blendedCac = sum.newCustomers > 0 ? sum.adSpend / sum.newCustomers : 0;

  return { aov, codPercent, prepaidPercent, cancellationPercent, rtoPercent, blendedRoas, costPerOrder, blendedCac };
}

export type { SalesPoint };
