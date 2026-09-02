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
        date: `${r.day.getFullYear()}-${String(r.day.getMonth() + 1).padStart(2, "0")}-${String(r.day.getDate()).padStart(2, "0")}`,
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

router.get("/orders", requireAuth, async (req, res, next) => {
  try {
    const clientId = req.params.id;
    await assertClientAccess(pool, req.auth!.userId, clientId);
    const limit = Math.max(1, Math.min(500, Number(req.query.limit) || 60));

    const result = await pool.query(
      `select
         o.id, o.customer_name, o.order_date, o.amount, o.status, o.payment_method, o.city, o.state,
         (select li.product_name from shopify_order_line_items li where li.order_id = o.id order by li.id limit 1) as product_name
       from shopify_orders o
       where o.client_id = $1
       order by o.order_date desc
       limit $2`,
      [clientId, limit],
    );

    res.json(
      result.rows.map((r) => ({
        id: r.id,
        clientId,
        customer: r.customer_name,
        date: r.order_date.toISOString(),
        amount: r.amount,
        status: r.status,
        payment: r.payment_method,
        city: r.city ?? "",
        state: r.state ?? "",
        courier: "",
        product: r.product_name ?? "",
      })),
    );
  } catch (err) {
    next(err);
  }
});

router.get("/products", requireAuth, async (req, res, next) => {
  try {
    const clientId = req.params.id;
    await assertClientAccess(pool, req.auth!.userId, clientId);

    const result = await pool.query(
      `select
         li.product_name,
         sum(li.quantity)::int as orders,
         sum(li.quantity * li.price)::int as sales,
         sum(li.quantity * li.price) filter (where o.status <> 'Cancelled')::int as net_sales,
         coalesce(sum(li.quantity) filter (where o.status = 'RTO Initiated' or o.status = 'RTO Delivered'), 0)::int as rto_quantity,
         coalesce(sum(li.quantity) filter (where o.status = 'Cancelled'), 0)::int as cancelled_quantity
       from shopify_order_line_items li
       join shopify_orders o on o.id = li.order_id
       where o.client_id = $1
       group by li.product_name
       order by sales desc`,
      [clientId],
    );

    res.json(
      result.rows.map((r) => ({
        id: r.product_name,
        name: r.product_name,
        image: "",
        category: "",
        orders: r.orders,
        sales: r.sales,
        netSales: r.net_sales ?? 0,
        rtoPercent: r.orders > 0 ? (r.rto_quantity / r.orders) * 100 : 0,
        cancellationPercent: r.orders > 0 ? (r.cancelled_quantity / r.orders) * 100 : 0,
        trend: [],
      })),
    );
  } catch (err) {
    next(err);
  }
});

router.get("/geography", requireAuth, async (req, res, next) => {
  try {
    const clientId = req.params.id;
    await assertClientAccess(pool, req.auth!.userId, clientId);
    const level = req.query.level === "city" ? "city" : "state";

    const result = await pool.query(
      `select
         ${level} as name,
         count(*)::int as orders,
         sum(amount)::int as sales,
         count(*) filter (where status = 'Delivered')::int as delivered,
         count(*) filter (where status = 'RTO Initiated' or status = 'RTO Delivered')::int as rto,
         count(*) filter (where status = 'Cancelled')::int as cancelled,
         count(*)::int as total
       from shopify_orders
       where client_id = $1 and ${level} is not null
       group by ${level}
       order by sales desc`,
      [clientId],
    );

    res.json(
      result.rows.map((r) => ({
        name: r.name,
        orders: r.orders,
        sales: r.sales,
        delivered: r.delivered,
        rto: r.rto,
        rtoPercent: r.total > 0 ? (r.rto / r.total) * 100 : 0,
        cancellationPercent: r.total > 0 ? (r.cancelled / r.total) * 100 : 0,
        previousRtoPercent: 0,
      })),
    );
  } catch (err) {
    next(err);
  }
});

export default router;
