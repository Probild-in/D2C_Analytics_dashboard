import * as React from "react";
import { useApp } from "@/store/app-context";
import { rangeToDays } from "@/lib/date-range";
import { getAllClientsSalesSeries, getSalesSeries, sumSeries } from "@/data/mock";
import type { SalesPoint } from "@/data/types";

export function usePeriodData() {
  const { clientId, isAllClients, dateRange } = useApp();
  const days = rangeToDays(dateRange);

  return React.useMemo(() => {
    const total = isAllClients ? getAllClientsSalesSeries(days * 2) : getSalesSeries(clientId, days * 2);
    const current = total.slice(days);
    const previous = total.slice(0, days);
    return {
      days,
      current,
      previous,
      currentSum: sumSeries(current),
      previousSum: sumSeries(previous),
    };
  }, [clientId, isAllClients, days]);
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
