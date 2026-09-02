import { Router } from "express";
import pool from "../db.js";
import { requireAuth } from "../middleware/auth.js";
import { assertClientAccess } from "../lib/access.js";

const router = Router({ mergeParams: true });

router.get("/sales", requireAuth, async (req, res, next) => {
  try {
    const clientId = req.params.id;
    await assertClientAccess(pool, req.auth!.userId, clientId);
    const days = Math.max(1, Math.min(730, Number(req.query.days) || 90));

    const result = await pool.query(
      `with days as (
         select generate_series(current_date - ($2::int - 1), current_date, interval '1 day')::date as day
       ),
       orders_by_day as (
         select
           order_date::date as day,
           count(*) as orders,
           coalesce(sum(amount) filter (where status <> 'Cancelled'), 0) as net_sales,
           coalesce(sum(amount), 0) as gross_sales,
           count(*) filter (where status = 'Cancelled') as cancelled_orders,
           count(*) filter (where payment_method = 'COD') as cod_orders,
           count(*) filter (where payment_method = 'Prepaid') as prepaid_orders,
           count(*) filter (
             where shopify_customer_id is not null
             and order_date::date = (
               select min(o2.order_date)::date from shopify_orders o2
               where o2.client_id = shopify_orders.client_id and o2.shopify_customer_id = shopify_orders.shopify_customer_id
             )
           ) as new_customers,
           count(*) filter (
             where shopify_customer_id is not null
             and order_date::date <> (
               select min(o2.order_date)::date from shopify_orders o2
               where o2.client_id = shopify_orders.client_id and o2.shopify_customer_id = shopify_orders.shopify_customer_id
             )
           ) as returning_customers
         from shopify_orders
         where client_id = $1 and order_date >= current_date - ($2::int - 1)
         group by order_date::date
       )
       select
         days.day,
         coalesce(orders_by_day.gross_sales, 0)::int as gross_sales,
         coalesce(orders_by_day.net_sales, 0)::int as net_sales,
         coalesce(orders_by_day.orders, 0)::int as orders,
         coalesce(orders_by_day.new_customers, 0)::int as new_customers,
         coalesce(orders_by_day.returning_customers, 0)::int as returning_customers,
         coalesce(orders_by_day.cod_orders, 0)::int as cod_orders,
         coalesce(orders_by_day.prepaid_orders, 0)::int as prepaid_orders,
         coalesce(orders_by_day.cancelled_orders, 0)::int as cancelled_orders
       from days
       left join orders_by_day on orders_by_day.day = days.day
       order by days.day`,
      [clientId, days],
    );

    res.json(
      result.rows.map((r) => ({
        date: r.day.toISOString().slice(0, 10),
        grossSales: r.gross_sales,
        netSales: r.net_sales,
        orders: r.orders,
        adSpend: 0,
        newCustomers: r.new_customers,
        returningCustomers: r.returning_customers,
        codOrders: r.cod_orders,
        prepaidOrders: r.prepaid_orders,
        cancelledOrders: r.cancelled_orders,
        rtoOrders: 0,
      })),
    );
  } catch (err) {
    next(err);
  }
});

export default router;
