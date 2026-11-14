-- Shipway joins the allowed connection platforms (same pattern as 006 adding Shiprocket).
alter table platform_connections drop constraint platform_connections_platform_check;
alter table platform_connections add constraint platform_connections_platform_check
  check (platform in ('shopify', 'meta', 'google', 'courier_delhivery', 'courier_shadowfax', 'courier_shiprocket', 'courier_shipway'));
