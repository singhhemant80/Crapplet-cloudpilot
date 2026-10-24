-- Every IP status transition is recorded, regardless of which code path made it.
-- Callers may set a reason with: SELECT set_config('cloudpilot.ip_reason', '...', true)
CREATE OR REPLACE FUNCTION cp_ip_history() RETURNS trigger AS $$
BEGIN
  IF NEW.status IS DISTINCT FROM OLD.status THEN
    INSERT INTO ip_allocation_events (ip_address_id, from_status, to_status, order_id, service_id, reason)
    VALUES (NEW.id, OLD.status, NEW.status, coalesce(NEW.order_id, OLD.order_id), coalesce(NEW.service_id, OLD.service_id),
            coalesce(nullif(current_setting('cloudpilot.ip_reason', true), ''), 'unspecified'));
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER cp_ip_history BEFORE UPDATE ON "ip_addresses" FOR EACH ROW EXECUTE FUNCTION cp_ip_history();
--> statement-breakpoint
-- An address can be bound to at most one in-flight order reservation.
CREATE INDEX IF NOT EXISTS "ip_addresses_reserved_until_idx" ON "ip_addresses" ("reserved_until") WHERE "status" = 'RESERVED';
