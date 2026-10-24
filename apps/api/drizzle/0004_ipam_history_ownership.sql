-- Also record ownership changes that keep the same status (e.g. an expired checkout
-- reservation re-reserved by someone else, or a reservation being bound to an order).
CREATE OR REPLACE FUNCTION cp_ip_history() RETURNS trigger AS $$
BEGIN
  IF NEW.status IS DISTINCT FROM OLD.status
     OR NEW.reservation_token IS DISTINCT FROM OLD.reservation_token
     OR NEW.order_id IS DISTINCT FROM OLD.order_id
     OR NEW.service_id IS DISTINCT FROM OLD.service_id THEN
    INSERT INTO ip_allocation_events (ip_address_id, from_status, to_status, order_id, service_id, reason)
    VALUES (NEW.id, OLD.status, NEW.status, coalesce(NEW.order_id, OLD.order_id), coalesce(NEW.service_id, OLD.service_id),
            coalesce(nullif(current_setting('cloudpilot.ip_reason', true), ''), 'unspecified'));
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
