CREATE TYPE "public"."email_status" AS ENUM('QUEUED', 'SENT', 'FAILED');--> statement-breakpoint
CREATE TYPE "public"."invoice_kind" AS ENUM('NEW_ORDER', 'RENEWAL', 'UPGRADE', 'MANUAL');--> statement-breakpoint
CREATE TYPE "public"."invoice_status" AS ENUM('DRAFT', 'UNPAID', 'PARTIALLY_PAID', 'PAID', 'OVERDUE', 'VOID', 'REFUNDED');--> statement-breakpoint
CREATE TYPE "public"."payment_status" AS ENUM('PENDING', 'SUCCEEDED', 'FAILED', 'REFUNDED');--> statement-breakpoint
CREATE TYPE "public"."tax_type" AS ENUM('INTRA', 'INTER', 'EXPORT', 'NONE');--> statement-breakpoint
CREATE TYPE "public"."ticket_priority" AS ENUM('LOW', 'MEDIUM', 'HIGH', 'URGENT');--> statement-breakpoint
CREATE TYPE "public"."ticket_status" AS ENUM('OPEN', 'ANSWERED', 'CUSTOMER_REPLY', 'ON_HOLD', 'CLOSED');--> statement-breakpoint
CREATE TABLE "announcements" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"title" text NOT NULL,
	"body" text NOT NULL,
	"audience" text DEFAULT 'ALL' NOT NULL,
	"published" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "email_messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"to_address" text NOT NULL,
	"subject" text NOT NULL,
	"body" text NOT NULL,
	"template_key" text,
	"status" "email_status" DEFAULT 'QUEUED' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"related_type" text,
	"related_id" text,
	"sent_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "email_templates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"key" text NOT NULL,
	"subject" text NOT NULL,
	"body" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "invoice_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"invoice_id" uuid NOT NULL,
	"description" text NOT NULL,
	"hsn_sac" text,
	"quantity" integer DEFAULT 1 NOT NULL,
	"unit_minor" bigint NOT NULL,
	"amount_minor" bigint NOT NULL,
	"tax_rate_bp" integer DEFAULT 0 NOT NULL,
	"product_id" uuid,
	"service_id" uuid,
	"sort_order" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "invoice_sequences" (
	"tenant_id" uuid NOT NULL,
	"financial_year" text NOT NULL,
	"next" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "invoices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"customer_id" uuid NOT NULL,
	"number" text,
	"financial_year" text,
	"status" "invoice_status" DEFAULT 'DRAFT' NOT NULL,
	"kind" "invoice_kind" NOT NULL,
	"currency" char(3) NOT NULL,
	"issue_date" timestamp with time zone,
	"due_date" timestamp with time zone,
	"subtotal_minor" bigint DEFAULT 0 NOT NULL,
	"cgst_minor" bigint DEFAULT 0 NOT NULL,
	"sgst_minor" bigint DEFAULT 0 NOT NULL,
	"igst_minor" bigint DEFAULT 0 NOT NULL,
	"tax_minor" bigint DEFAULT 0 NOT NULL,
	"total_minor" bigint DEFAULT 0 NOT NULL,
	"paid_minor" bigint DEFAULT 0 NOT NULL,
	"tax_type" "tax_type" DEFAULT 'NONE' NOT NULL,
	"place_of_supply" text,
	"seller_gstin" text,
	"buyer_gstin" text,
	"buyer_name" text NOT NULL,
	"buyer_address" text DEFAULT '' NOT NULL,
	"order_id" uuid,
	"service_id" uuid,
	"period_start" timestamp with time zone,
	"period_end" timestamp with time zone,
	"notes" text DEFAULT '' NOT NULL,
	"paid_at" timestamp with time zone,
	"voided_at" timestamp with time zone,
	"reminder_sent_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "payments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"invoice_id" uuid NOT NULL,
	"customer_id" uuid NOT NULL,
	"gateway" text NOT NULL,
	"amount_minor" bigint NOT NULL,
	"currency" char(3) NOT NULL,
	"status" "payment_status" DEFAULT 'PENDING' NOT NULL,
	"gateway_order_id" text,
	"gateway_payment_id" text,
	"reference" text,
	"recorded_by_id" uuid,
	"paid_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ticket_departments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"active" boolean DEFAULT true NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ticket_messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"ticket_id" uuid NOT NULL,
	"author_type" text NOT NULL,
	"author_user_id" uuid,
	"author_name" text NOT NULL,
	"body" text NOT NULL,
	"internal" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tickets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"number" serial NOT NULL,
	"department_id" uuid NOT NULL,
	"customer_id" uuid,
	"reseller_id" uuid,
	"opened_by_user_id" uuid,
	"service_id" uuid,
	"subject" text NOT NULL,
	"status" "ticket_status" DEFAULT 'OPEN' NOT NULL,
	"priority" "ticket_priority" DEFAULT 'MEDIUM' NOT NULL,
	"last_reply_at" timestamp with time zone DEFAULT now() NOT NULL,
	"closed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN "company_name" text;--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN "phone" text;--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN "address1" text;--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN "address2" text;--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN "city" text;--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN "state" text;--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN "state_code" char(2);--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN "country" char(2) DEFAULT 'IN' NOT NULL;--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN "postal_code" text;--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN "gstin" text;--> statement-breakpoint
ALTER TABLE "price_lists" ADD COLUMN "is_default_retail" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "hsn_sac" text DEFAULT '998315' NOT NULL;--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "gst_rate_bp" integer DEFAULT 1800 NOT NULL;--> statement-breakpoint
ALTER TABLE "invoice_lines" ADD CONSTRAINT "invoice_lines_invoice_id_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."invoices"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_invoice_id_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."invoices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ticket_messages" ADD CONSTRAINT "ticket_messages_ticket_id_tickets_id_fk" FOREIGN KEY ("ticket_id") REFERENCES "public"."tickets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_department_id_ticket_departments_id_fk" FOREIGN KEY ("department_id") REFERENCES "public"."ticket_departments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_reseller_id_resellers_id_fk" FOREIGN KEY ("reseller_id") REFERENCES "public"."resellers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "email_messages_status_created_at_index" ON "email_messages" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "email_messages_tenant_id_created_at_index" ON "email_messages" USING btree ("tenant_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "email_templates_tenant_id_key_index" ON "email_templates" USING btree ("tenant_id","key");--> statement-breakpoint
CREATE UNIQUE INDEX "invoice_sequences_tenant_id_financial_year_index" ON "invoice_sequences" USING btree ("tenant_id","financial_year");--> statement-breakpoint
CREATE UNIQUE INDEX "invoices_tenant_id_number_index" ON "invoices" USING btree ("tenant_id","number");--> statement-breakpoint
CREATE INDEX "invoices_customer_id_created_at_index" ON "invoices" USING btree ("customer_id","created_at");--> statement-breakpoint
CREATE INDEX "invoices_status_due_date_index" ON "invoices" USING btree ("status","due_date");--> statement-breakpoint
CREATE UNIQUE INDEX "invoices_renewal_period_uq" ON "invoices" USING btree ("service_id","period_start") WHERE kind = 'RENEWAL' and status <> 'VOID';--> statement-breakpoint
CREATE UNIQUE INDEX "payments_gateway_gateway_order_id_index" ON "payments" USING btree ("gateway","gateway_order_id");--> statement-breakpoint
CREATE UNIQUE INDEX "payments_gateway_gateway_payment_id_index" ON "payments" USING btree ("gateway","gateway_payment_id");--> statement-breakpoint
CREATE INDEX "payments_invoice_id_index" ON "payments" USING btree ("invoice_id");--> statement-breakpoint
CREATE INDEX "ticket_messages_ticket_id_created_at_index" ON "ticket_messages" USING btree ("ticket_id","created_at");--> statement-breakpoint
CREATE INDEX "tickets_tenant_id_status_last_reply_at_index" ON "tickets" USING btree ("tenant_id","status","last_reply_at");--> statement-breakpoint
CREATE INDEX "tickets_customer_id_index" ON "tickets" USING btree ("customer_id");--> statement-breakpoint
CREATE INDEX "tickets_reseller_id_index" ON "tickets" USING btree ("reseller_id");--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_amounts_chk" CHECK ("subtotal_minor" >= 0 AND "tax_minor" >= 0 AND "total_minor" = "subtotal_minor" + "tax_minor" AND "paid_minor" >= 0);
--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_issued_numbered_chk" CHECK ("status" = 'DRAFT' OR "number" IS NOT NULL);
--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_amount_positive_chk" CHECK ("amount_minor" > 0);
--> statement-breakpoint
ALTER TABLE "products" ADD CONSTRAINT "products_gst_rate_chk" CHECK ("gst_rate_bp" BETWEEN 0 AND 10000);
--> statement-breakpoint
-- Issued invoices are legal documents: numbers, amounts and buyer details never change after issue.
CREATE OR REPLACE FUNCTION cp_invoice_immutable() RETURNS trigger AS $$
BEGIN
  IF OLD.status <> 'DRAFT' AND (
       NEW.number IS DISTINCT FROM OLD.number OR NEW.total_minor <> OLD.total_minor OR NEW.subtotal_minor <> OLD.subtotal_minor
    OR NEW.tax_minor <> OLD.tax_minor OR NEW.buyer_name <> OLD.buyer_name OR NEW.buyer_gstin IS DISTINCT FROM OLD.buyer_gstin
    OR NEW.issue_date IS DISTINCT FROM OLD.issue_date) THEN
    RAISE EXCEPTION 'issued invoice % cannot be altered; void it or issue a credit', OLD.number;
  END IF;
  IF TG_OP = 'DELETE' AND OLD.status <> 'DRAFT' THEN
    RAISE EXCEPTION 'issued invoices cannot be deleted';
  END IF;
  RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER cp_invoice_immutable BEFORE UPDATE OR DELETE ON "invoices" FOR EACH ROW EXECUTE FUNCTION cp_invoice_immutable();
