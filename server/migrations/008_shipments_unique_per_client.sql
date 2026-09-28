alter table shipments drop constraint shipments_connection_id_awb_key;
alter table shipments add constraint shipments_client_id_awb_key unique (client_id, awb);
