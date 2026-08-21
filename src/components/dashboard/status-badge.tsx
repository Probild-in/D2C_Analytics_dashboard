import { Badge } from "@/components/ui/badge";
import type { OrderStatus } from "@/data/types";

const STATUS_VARIANT: Record<OrderStatus, "positive" | "info" | "warning" | "negative" | "neutral"> = {
  Delivered: "positive",
  "RTO Delivered": "negative",
  "RTO Initiated": "negative",
  "Out for Delivery": "info",
  "In Transit": "info",
  Dispatched: "neutral",
  NDR: "warning",
  Cancelled: "neutral",
};

export function OrderStatusBadge({ status }: { status: OrderStatus }) {
  return (
    <Badge variant={STATUS_VARIANT[status]} dot>
      {status}
    </Badge>
  );
}
