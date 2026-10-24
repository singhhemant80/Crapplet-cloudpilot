-- CloudPilot data-integrity guarantees enforced by PostgreSQL itself.
-- Application bugs must not be able to corrupt the ledger or IP inventory.

-- ───────────────────────────── Ledger: account balances are derived, never written directly

ALTER TABLE "ledger_accounts"
  ADD CONSTRAINT "ledger_accounts_min_balance_chk"
  CHECK ("min_balance_minor" IS NULL OR "balance_minor" >= "min_balance_minor");
--> statement-breakpoint

CREATE OR REPLACE FUNCTION cp_ledger_account_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.balance_minor <> 0 THEN
      RAISE EXCEPTION 'ledger accounts must be opened with a zero balance';
    END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'ledger accounts cannot be deleted';
  END IF;
  IF NEW.balance_minor IS DISTINCT FROM OLD.balance_minor
     AND current_setting('cloudpilot.ledger_posting', true) IS DISTINCT FROM 'on' THEN
    RAISE EXCEPTION 'ledger account balances may only change by posting ledger entries';
  END IF;
  IF NEW.currency <> OLD.currency OR NEW.kind <> OLD.kind OR NEW.code <> OLD.code THEN
    RAISE EXCEPTION 'ledger account identity is immutable';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

CREATE TRIGGER cp_ledger_account_guard
  BEFORE INSERT OR UPDATE OR DELETE ON "ledger_accounts"
  FOR EACH ROW EXECUTE FUNCTION cp_ledger_account_guard();
--> statement-breakpoint

-- Posting an entry applies it to the account (row-locked) and records balance_after.
CREATE OR REPLACE FUNCTION cp_ledger_entry_apply() RETURNS trigger AS $$
DECLARE
  tx_currency char(3);
  acct_currency char(3);
BEGIN
  SELECT currency INTO tx_currency FROM ledger_transactions WHERE id = NEW.transaction_id;
  SELECT currency INTO acct_currency FROM ledger_accounts WHERE id = NEW.account_id;
  IF tx_currency IS DISTINCT FROM acct_currency THEN
    RAISE EXCEPTION 'ledger entry currency mismatch (tx %, account %)', tx_currency, acct_currency;
  END IF;
  IF NEW.amount_minor = 0 THEN
    RAISE EXCEPTION 'zero-amount ledger entries are not allowed';
  END IF;
  PERFORM set_config('cloudpilot.ledger_posting', 'on', true);
  UPDATE ledger_accounts
     SET balance_minor = balance_minor + NEW.amount_minor
   WHERE id = NEW.account_id
  RETURNING balance_minor INTO NEW.balance_after_minor;
  PERFORM set_config('cloudpilot.ledger_posting', 'off', true);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

CREATE TRIGGER cp_ledger_entry_apply
  BEFORE INSERT ON "ledger_entries"
  FOR EACH ROW EXECUTE FUNCTION cp_ledger_entry_apply();
--> statement-breakpoint

-- Append-only: no updates or deletes of posted ledger rows. Corrections are REVERSAL transactions.
CREATE OR REPLACE FUNCTION cp_ledger_immutable() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION '% is append-only; post a reversal instead', TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

CREATE TRIGGER cp_ledger_entries_immutable
  BEFORE UPDATE OR DELETE ON "ledger_entries"
  FOR EACH ROW EXECUTE FUNCTION cp_ledger_immutable();
--> statement-breakpoint

CREATE TRIGGER cp_ledger_transactions_immutable
  BEFORE UPDATE OR DELETE ON "ledger_transactions"
  FOR EACH ROW EXECUTE FUNCTION cp_ledger_immutable();
--> statement-breakpoint

-- Double entry: every transaction's entries sum to zero, checked at COMMIT.
CREATE OR REPLACE FUNCTION cp_ledger_zero_sum() RETURNS trigger AS $$
DECLARE
  total numeric;
  n int;
BEGIN
  SELECT coalesce(sum(amount_minor), 0), count(*) INTO total, n
    FROM ledger_entries WHERE transaction_id = NEW.transaction_id;
  IF n < 2 OR total <> 0 THEN
    RAISE EXCEPTION 'ledger transaction % is unbalanced (entries=%, sum=%)', NEW.transaction_id, n, total;
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

CREATE CONSTRAINT TRIGGER cp_ledger_zero_sum
  AFTER INSERT ON "ledger_entries"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION cp_ledger_zero_sum();
--> statement-breakpoint

ALTER TABLE "ledger_transactions" ADD CONSTRAINT "ledger_tx_amount_positive_chk" CHECK ("amount_minor" > 0);
--> statement-breakpoint
ALTER TABLE "wallet_holds" ADD CONSTRAINT "wallet_holds_split_chk"
  CHECK ("amount_minor" > 0 AND "cash_minor" >= 0 AND "credit_minor" >= 0 AND "cash_minor" + "credit_minor" = "amount_minor");
--> statement-breakpoint
ALTER TABLE "deposits" ADD CONSTRAINT "deposits_amount_positive_chk" CHECK ("amount_minor" > 0);
--> statement-breakpoint
ALTER TABLE "prices" ADD CONSTRAINT "prices_non_negative_chk" CHECK ("amount_minor" >= 0 AND "setup_fee_minor" >= 0);
--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_non_negative_chk" CHECK ("wholesale_minor" >= 0 AND "setup_fee_minor" >= 0);
--> statement-breakpoint
ALTER TABLE "resellers" ADD CONSTRAINT "resellers_credit_limit_chk" CHECK ("credit_limit_minor" >= 0);
--> statement-breakpoint

-- ───────────────────────────── IPAM state invariants

ALTER TABLE "ip_addresses" ADD CONSTRAINT "ip_reserved_has_expiry_chk"
  CHECK ("status" <> 'RESERVED' OR ("reserved_until" IS NOT NULL AND "reservation_token" IS NOT NULL));
--> statement-breakpoint
ALTER TABLE "ip_addresses" ADD CONSTRAINT "ip_allocated_has_service_chk"
  CHECK ("status" <> 'ALLOCATED' OR "service_id" IS NOT NULL);
--> statement-breakpoint
ALTER TABLE "ip_addresses" ADD CONSTRAINT "ip_available_is_clean_chk"
  CHECK ("status" <> 'AVAILABLE' OR ("service_id" IS NULL AND "order_id" IS NULL AND "reservation_token" IS NULL));
--> statement-breakpoint
ALTER TABLE "ip_pools" ADD CONSTRAINT "ip_pools_version_chk" CHECK ("version" IN (4, 6));
