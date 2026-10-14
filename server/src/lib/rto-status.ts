// Shopify has no native concept of RTO — shopify.ts's mapOrderStatus() only ever produces
// Cancelled/Delivered/Dispatched, confirmed live: a real client's shopify_orders.status is
// NEVER actually 'RTO Initiated'/'RTO Delivered'. Once a courier (Shiprocket/Delhivery) is
// connected, shipments.status is the only real source of RTO truth. Both courier connectors
// populate shipments.order_ref with the matching shopify_orders.shopify_order_id (confirmed
// in delhivery.ts, which looks the candidate up directly from shopify_orders; shiprocket.ts's
// channel_order_id is expected to match the same way), so that's the join to use.
//
// Single-client version: embed this CTE set (via `with ${ORDER_RTO_CTES_SINGLE_CLIENT}
// select ...`) in a query where $1 is bound to one client_id.
export const ORDER_RTO_CTES_SINGLE_CLIENT = `
  has_shipments as (
    select exists (select 1 from shipments where client_id = $1) as flag
  ),
  order_rto as (
    select o.id as order_id,
      case
        when hs.flag then exists (
          select 1 from shipments s
          where s.client_id = $1 and s.order_ref = o.shopify_order_id
            and s.status in ('RTO Initiated', 'RTO Delivered')
        )
        else o.status in ('RTO Initiated', 'RTO Delivered')
      end as is_rto
    from shopify_orders o, has_shipments hs
    where o.client_id = $1
  )
`;
