alter table platform_connections drop constraint platform_connections_platform_check;
alter table platform_connections add constraint platform_connections_platform_check
  check (platform in ('shopify', 'meta', 'google', 'courier_delhivery', 'courier_shadowfax', 'courier_shiprocket'));

-- AES-256-GCM encrypted JSON blob (via encryptToken). Holds secrets a connector needs to
-- re-authenticate later, e.g. Shiprocket's email + password. Null for token-only platforms.
alter table platform_connections add column credentials text;
