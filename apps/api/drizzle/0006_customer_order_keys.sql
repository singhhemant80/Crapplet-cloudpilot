-- Store orders have no reseller; NULLs are distinct in the main unique index, so guard them separately.
CREATE UNIQUE INDEX IF NOT EXISTS "orders_customer_idempotency_uq" ON "orders" ("tenant_id", "idempotency_key") WHERE "reseller_id" IS NULL;
