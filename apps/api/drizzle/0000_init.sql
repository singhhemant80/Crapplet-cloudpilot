CREATE TYPE "public"."billing_cycle" AS ENUM('ONE_TIME', 'MONTHLY', 'QUARTERLY', 'SEMIANNUAL', 'ANNUAL');--> statement-breakpoint
CREATE TYPE "public"."customer_ownership" AS ENUM('RESELLER_OWNED', 'CENTRAL');--> statement-breakpoint
CREATE TYPE "public"."delivery_status" AS ENUM('PENDING', 'SUCCEEDED', 'FAILED', 'DEAD');--> statement-breakpoint
CREATE TYPE "public"."deposit_method" AS ENUM('GATEWAY', 'BANK_TRANSFER', 'MANUAL_ADJUSTMENT', 'PROMO');--> statement-breakpoint
CREATE TYPE "public"."deposit_status" AS ENUM('AWAITING_PAYMENT', 'UNDER_REVIEW', 'CREDITED', 'REJECTED', 'FAILED', 'EXPIRED');--> statement-breakpoint
CREATE TYPE "public"."hold_status" AS ENUM('HELD', 'CAPTURED', 'RELEASED');--> statement-breakpoint
CREATE TYPE "public"."integration_platform" AS ENUM('WHMCS', 'BLESTA', 'HOSTBILL', 'WISECP', 'CLIENTEXEC', 'CUSTOM');--> statement-breakpoint
CREATE TYPE "public"."ip_status" AS ENUM('AVAILABLE', 'RESERVED', 'ALLOCATED', 'QUARANTINED', 'RETIRED');--> statement-breakpoint
CREATE TYPE "public"."ledger_account_kind" AS ENUM('RESELLER_AVAILABLE', 'RESELLER_RESERVED', 'RESELLER_CREDIT', 'RESELLER_PROMO', 'SYSTEM_GATEWAY_CLEARING', 'SYSTEM_BANK_CLEARING', 'SYSTEM_REVENUE', 'SYSTEM_ADJUSTMENTS', 'SYSTEM_PROMO_EXPENSE');--> statement-breakpoint
CREATE TYPE "public"."ledger_tx_type" AS ENUM('DEPOSIT', 'HOLD', 'CAPTURE', 'RELEASE', 'CHARGE', 'REFUND', 'ADJUSTMENT', 'PROMO_GRANT', 'REVERSAL');--> statement-breakpoint
CREATE TYPE "public"."order_source" AS ENUM('PORTAL', 'API', 'WHMCS', 'ADMIN');--> statement-breakpoint
CREATE TYPE "public"."order_status" AS ENUM('PENDING_PAYMENT', 'PAID_OR_AUTHORIZED', 'QUEUED', 'PROVISIONING', 'CONFIGURING_NETWORK', 'VERIFYING', 'ACTIVE', 'FAILED', 'NEEDS_ATTENTION', 'CANCELLED');--> statement-breakpoint
CREATE TYPE "public"."product_status" AS ENUM('DRAFT', 'ACTIVE', 'RETIRED');--> statement-breakpoint
CREATE TYPE "public"."product_type" AS ENUM('VPS_LINUX', 'VPS_WINDOWS', 'VPS_FOREX', 'VPS_MINECRAFT', 'GPU_CLOUD', 'SHARED_HOSTING', 'RESELLER_HOSTING', 'DEDICATED', 'COLOCATION', 'OBJECT_STORAGE', 'BACKUP_STORAGE', 'IP_ADDON', 'BANDWIDTH_ADDON', 'SSL', 'DOMAIN', 'CUSTOM');--> statement-breakpoint
CREATE TYPE "public"."provider_status" AS ENUM('UNVERIFIED', 'CONNECTED', 'ERROR', 'DISABLED');--> statement-breakpoint
CREATE TYPE "public"."provisioning_mode" AS ENUM('AUTOMATIC', 'MANUAL_APPROVAL');--> statement-breakpoint
CREATE TYPE "public"."reseller_model" AS ENUM('PREPAID', 'CREDIT', 'COMMISSION');--> statement-breakpoint
CREATE TYPE "public"."reseller_status" AS ENUM('PENDING', 'ACTIVE', 'SUSPENDED');--> statement-breakpoint
CREATE TYPE "public"."service_status" AS ENUM('PENDING', 'PROVISIONING', 'ACTIVE', 'SUSPENDED', 'TERMINATED', 'FAILED', 'NEEDS_ATTENTION');--> statement-breakpoint
CREATE TYPE "public"."user_role" AS ENUM('PLATFORM_ADMIN', 'TENANT_ADMIN', 'STAFF', 'RESELLER_ADMIN', 'CUSTOMER');--> statement-breakpoint
CREATE TYPE "public"."user_status" AS ENUM('ACTIVE', 'DISABLED');--> statement-breakpoint
CREATE TABLE "api_credentials" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"reseller_id" uuid,
	"name" text NOT NULL,
	"key_id" text NOT NULL,
	"secret_hash" text NOT NULL,
	"scopes" text[] NOT NULL,
	"ip_allowlist" text[] DEFAULT '{}'::text[] NOT NULL,
	"last_used_at" timestamp with time zone,
	"expires_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "api_credentials_keyId_unique" UNIQUE("key_id")
);
--> statement-breakpoint
CREATE TABLE "audit_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"actor_type" text NOT NULL,
	"actor_id" text,
	"reseller_id" uuid,
	"action" text NOT NULL,
	"target_type" text,
	"target_id" text,
	"ip" text,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "customers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"reseller_id" uuid,
	"external_ref" text,
	"name" text NOT NULL,
	"email" text,
	"ownership" "customer_ownership" DEFAULT 'CENTRAL' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "deposits" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"reseller_id" uuid NOT NULL,
	"method" "deposit_method" NOT NULL,
	"gateway" text,
	"amount_minor" bigint NOT NULL,
	"currency" char(3) NOT NULL,
	"status" "deposit_status" NOT NULL,
	"bank_reference" text,
	"proof_note" text,
	"gateway_order_id" text,
	"gateway_payment_id" text,
	"source" text DEFAULT 'PORTAL' NOT NULL,
	"external_ref" text,
	"reviewed_by_id" uuid,
	"reviewed_at" timestamp with time zone,
	"reject_reason" text,
	"ledger_transaction_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "external_product_mappings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"connection_id" uuid NOT NULL,
	"external_product_id" text NOT NULL,
	"product_id" uuid NOT NULL,
	"retail_minor" bigint,
	"retail_currency" char(3),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "hypervisor_networks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider_id" uuid NOT NULL,
	"node" text NOT NULL,
	"external_id" text NOT NULL,
	"type" text NOT NULL,
	"vlan_aware" boolean NOT NULL,
	"active" boolean NOT NULL
);
--> statement-breakpoint
CREATE TABLE "hypervisor_nodes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider_id" uuid NOT NULL,
	"name" text NOT NULL,
	"status" text NOT NULL,
	"cpu_cores" integer,
	"cpu_usage" double precision,
	"memory_total_bytes" bigint,
	"memory_used_bytes" bigint,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "hypervisor_providers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"name" text NOT NULL,
	"type" text NOT NULL,
	"endpoint" text NOT NULL,
	"encrypted_credentials" text NOT NULL,
	"ca_certificate" text,
	"allow_insecure_tls" boolean DEFAULT false NOT NULL,
	"options" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" "provider_status" DEFAULT 'UNVERIFIED' NOT NULL,
	"version" text,
	"last_checked_at" timestamp with time zone,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "hypervisor_storages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider_id" uuid NOT NULL,
	"node" text NOT NULL,
	"external_id" text NOT NULL,
	"type" text NOT NULL,
	"content_types" text[] NOT NULL,
	"total_bytes" bigint,
	"used_bytes" bigint,
	"shared" boolean NOT NULL,
	"active" boolean NOT NULL
);
--> statement-breakpoint
CREATE TABLE "integration_connections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"reseller_id" uuid NOT NULL,
	"platform" "integration_platform" NOT NULL,
	"name" text NOT NULL,
	"site_url" text,
	"last_seen_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ip_addresses" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"pool_id" uuid NOT NULL,
	"address" text NOT NULL,
	"status" "ip_status" DEFAULT 'AVAILABLE' NOT NULL,
	"reservation_token" text,
	"reserved_until" timestamp with time zone,
	"reserved_by_reseller_id" uuid,
	"order_id" uuid,
	"service_id" uuid,
	"quarantine_until" timestamp with time zone,
	"rdns" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ip_addresses_reservationToken_unique" UNIQUE("reservation_token")
);
--> statement-breakpoint
CREATE TABLE "ip_allocation_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"ip_address_id" uuid NOT NULL,
	"from_status" "ip_status" NOT NULL,
	"to_status" "ip_status" NOT NULL,
	"order_id" uuid,
	"service_id" uuid,
	"reason" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ip_pools" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"name" text NOT NULL,
	"version" integer NOT NULL,
	"cidr" text NOT NULL,
	"prefix_length" integer NOT NULL,
	"gateway" text,
	"nameservers" text[] DEFAULT '{}'::text[] NOT NULL,
	"vlan_tag" integer,
	"customer_selectable" boolean DEFAULT true NOT NULL,
	"quarantine_hours" integer DEFAULT 72 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ledger_accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"code" text NOT NULL,
	"kind" "ledger_account_kind" NOT NULL,
	"reseller_id" uuid,
	"currency" char(3) NOT NULL,
	"balance_minor" bigint DEFAULT 0 NOT NULL,
	"min_balance_minor" bigint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ledger_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"transaction_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"amount_minor" bigint NOT NULL,
	"balance_after_minor" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ledger_transactions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"reseller_id" uuid,
	"type" "ledger_tx_type" NOT NULL,
	"currency" char(3) NOT NULL,
	"amount_minor" bigint NOT NULL,
	"idempotency_key" text NOT NULL,
	"source_type" text NOT NULL,
	"source_id" text NOT NULL,
	"actor_type" text NOT NULL,
	"actor_id" text,
	"memo" text DEFAULT '' NOT NULL,
	"reversal_of_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ledger_transactions_reversalOfId_unique" UNIQUE("reversal_of_id")
);
--> statement-breakpoint
CREATE TABLE "locations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"country" char(2) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "order_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"order_id" uuid NOT NULL,
	"status" "order_status" NOT NULL,
	"message" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "orders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"number" serial NOT NULL,
	"reseller_id" uuid,
	"customer_id" uuid,
	"source" "order_source" NOT NULL,
	"idempotency_key" text NOT NULL,
	"request_hash" text NOT NULL,
	"product_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"template_id" uuid NOT NULL,
	"cycle" "billing_cycle" NOT NULL,
	"hostname" text NOT NULL,
	"status" "order_status" NOT NULL,
	"currency" char(3) NOT NULL,
	"wholesale_minor" bigint NOT NULL,
	"setup_fee_minor" bigint DEFAULT 0 NOT NULL,
	"retail_minor" bigint,
	"retail_currency" char(3),
	"failure_reason" text,
	"attempts" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "os_templates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider_id" uuid NOT NULL,
	"external_id" text NOT NULL,
	"node" text NOT NULL,
	"name" text NOT NULL,
	"kind" text NOT NULL,
	"os_family" text DEFAULT 'linux' NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL
);
--> statement-breakpoint
CREATE TABLE "payment_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"gateway" text NOT NULL,
	"event_id" text NOT NULL,
	"signature_valid" boolean NOT NULL,
	"payload" jsonb NOT NULL,
	"processed_at" timestamp with time zone,
	"result" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "price_lists" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"name" text NOT NULL,
	"currency" char(3) NOT NULL,
	"is_default_wholesale" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "prices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"price_list_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"cycle" "billing_cycle" NOT NULL,
	"amount_minor" bigint NOT NULL,
	"setup_fee_minor" bigint DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "product_placements" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"product_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"provider_id" uuid NOT NULL,
	"node" text NOT NULL,
	"storage" text,
	"bridge" text DEFAULT 'vmbr0' NOT NULL,
	"vlan_tag" integer,
	"ipv4_pool_id" uuid,
	"ipv6_pool_id" uuid,
	"template_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL
);
--> statement-breakpoint
CREATE TABLE "products" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"sku" text NOT NULL,
	"name" text NOT NULL,
	"type" "product_type" NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"status" "product_status" DEFAULT 'DRAFT' NOT NULL,
	"provisioning" "provisioning_mode" DEFAULT 'AUTOMATIC' NOT NULL,
	"cpu_cores" integer,
	"memory_mb" integer,
	"disk_gb" integer,
	"bandwidth_gb" integer,
	"ipv4_count" integer DEFAULT 1 NOT NULL,
	"ipv6_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "resellers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"name" text NOT NULL,
	"contact_email" text NOT NULL,
	"status" "reseller_status" DEFAULT 'PENDING' NOT NULL,
	"model" "reseller_model" DEFAULT 'PREPAID' NOT NULL,
	"currency" char(3) DEFAULT 'INR' NOT NULL,
	"credit_limit_minor" bigint DEFAULT 0 NOT NULL,
	"low_balance_threshold_minor" bigint DEFAULT 0 NOT NULL,
	"price_list_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "service_renewals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"service_id" uuid NOT NULL,
	"idempotency_key" text NOT NULL,
	"period_start" timestamp with time zone NOT NULL,
	"period_end" timestamp with time zone NOT NULL,
	"amount_minor" bigint NOT NULL,
	"ledger_transaction_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "services" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"reseller_id" uuid,
	"customer_id" uuid,
	"order_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"provider_id" uuid,
	"status" "service_status" DEFAULT 'PENDING' NOT NULL,
	"hostname" text NOT NULL,
	"vm_name" text NOT NULL,
	"node" text,
	"external_vm_id" text,
	"cpu_cores" integer NOT NULL,
	"memory_mb" integer NOT NULL,
	"disk_gb" integer NOT NULL,
	"username" text DEFAULT 'cloud' NOT NULL,
	"cycle" "billing_cycle" NOT NULL,
	"renewal_minor" bigint NOT NULL,
	"currency" char(3) NOT NULL,
	"next_due_date" timestamp with time zone,
	"suspended_reason" text,
	"terminated_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "services_orderId_unique" UNIQUE("order_id"),
	CONSTRAINT "services_vmName_unique" UNIQUE("vm_name")
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"ip" text,
	"user_agent" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sessions_tokenHash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "tenants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"brand_name" text DEFAULT 'CloudPilot' NOT NULL,
	"settings" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tenants_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"email" text NOT NULL,
	"name" text NOT NULL,
	"password_hash" text NOT NULL,
	"role" "user_role" NOT NULL,
	"status" "user_status" DEFAULT 'ACTIVE' NOT NULL,
	"reseller_id" uuid,
	"customer_id" uuid,
	"failed_logins" integer DEFAULT 0 NOT NULL,
	"locked_until" timestamp with time zone,
	"last_login_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "wallet_holds" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"reseller_id" uuid NOT NULL,
	"order_id" uuid NOT NULL,
	"currency" char(3) NOT NULL,
	"amount_minor" bigint NOT NULL,
	"cash_minor" bigint NOT NULL,
	"credit_minor" bigint NOT NULL,
	"status" "hold_status" DEFAULT 'HELD' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"settled_at" timestamp with time zone,
	CONSTRAINT "wallet_holds_orderId_unique" UNIQUE("order_id")
);
--> statement-breakpoint
CREATE TABLE "webhook_deliveries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event_id" text NOT NULL,
	"endpoint_id" uuid NOT NULL,
	"status" "delivery_status" DEFAULT 'PENDING' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_status_code" integer,
	"last_error" text,
	"delivered_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "webhook_endpoints" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"reseller_id" uuid NOT NULL,
	"url" text NOT NULL,
	"encrypted_secret" text NOT NULL,
	"events" text[] NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "webhook_events" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"reseller_id" uuid,
	"type" text NOT NULL,
	"payload" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "api_credentials" ADD CONSTRAINT "api_credentials_reseller_id_resellers_id_fk" FOREIGN KEY ("reseller_id") REFERENCES "public"."resellers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customers" ADD CONSTRAINT "customers_reseller_id_resellers_id_fk" FOREIGN KEY ("reseller_id") REFERENCES "public"."resellers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deposits" ADD CONSTRAINT "deposits_reseller_id_resellers_id_fk" FOREIGN KEY ("reseller_id") REFERENCES "public"."resellers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "external_product_mappings" ADD CONSTRAINT "external_product_mappings_connection_id_integration_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."integration_connections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "external_product_mappings" ADD CONSTRAINT "external_product_mappings_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hypervisor_networks" ADD CONSTRAINT "hypervisor_networks_provider_id_hypervisor_providers_id_fk" FOREIGN KEY ("provider_id") REFERENCES "public"."hypervisor_providers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hypervisor_nodes" ADD CONSTRAINT "hypervisor_nodes_provider_id_hypervisor_providers_id_fk" FOREIGN KEY ("provider_id") REFERENCES "public"."hypervisor_providers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hypervisor_providers" ADD CONSTRAINT "hypervisor_providers_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hypervisor_storages" ADD CONSTRAINT "hypervisor_storages_provider_id_hypervisor_providers_id_fk" FOREIGN KEY ("provider_id") REFERENCES "public"."hypervisor_providers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "integration_connections" ADD CONSTRAINT "integration_connections_reseller_id_resellers_id_fk" FOREIGN KEY ("reseller_id") REFERENCES "public"."resellers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ip_addresses" ADD CONSTRAINT "ip_addresses_pool_id_ip_pools_id_fk" FOREIGN KEY ("pool_id") REFERENCES "public"."ip_pools"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ip_allocation_events" ADD CONSTRAINT "ip_allocation_events_ip_address_id_ip_addresses_id_fk" FOREIGN KEY ("ip_address_id") REFERENCES "public"."ip_addresses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ip_pools" ADD CONSTRAINT "ip_pools_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_transaction_id_ledger_transactions_id_fk" FOREIGN KEY ("transaction_id") REFERENCES "public"."ledger_transactions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_account_id_ledger_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."ledger_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_events" ADD CONSTRAINT "order_events_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_reseller_id_resellers_id_fk" FOREIGN KEY ("reseller_id") REFERENCES "public"."resellers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_template_id_os_templates_id_fk" FOREIGN KEY ("template_id") REFERENCES "public"."os_templates"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "os_templates" ADD CONSTRAINT "os_templates_provider_id_hypervisor_providers_id_fk" FOREIGN KEY ("provider_id") REFERENCES "public"."hypervisor_providers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prices" ADD CONSTRAINT "prices_price_list_id_price_lists_id_fk" FOREIGN KEY ("price_list_id") REFERENCES "public"."price_lists"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prices" ADD CONSTRAINT "prices_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_placements" ADD CONSTRAINT "product_placements_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_placements" ADD CONSTRAINT "product_placements_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_placements" ADD CONSTRAINT "product_placements_provider_id_hypervisor_providers_id_fk" FOREIGN KEY ("provider_id") REFERENCES "public"."hypervisor_providers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_placements" ADD CONSTRAINT "product_placements_ipv4_pool_id_ip_pools_id_fk" FOREIGN KEY ("ipv4_pool_id") REFERENCES "public"."ip_pools"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_placements" ADD CONSTRAINT "product_placements_ipv6_pool_id_ip_pools_id_fk" FOREIGN KEY ("ipv6_pool_id") REFERENCES "public"."ip_pools"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "resellers" ADD CONSTRAINT "resellers_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "resellers" ADD CONSTRAINT "resellers_price_list_id_price_lists_id_fk" FOREIGN KEY ("price_list_id") REFERENCES "public"."price_lists"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_renewals" ADD CONSTRAINT "service_renewals_service_id_services_id_fk" FOREIGN KEY ("service_id") REFERENCES "public"."services"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "services" ADD CONSTRAINT "services_reseller_id_resellers_id_fk" FOREIGN KEY ("reseller_id") REFERENCES "public"."resellers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "services" ADD CONSTRAINT "services_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "services" ADD CONSTRAINT "services_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "services" ADD CONSTRAINT "services_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "services" ADD CONSTRAINT "services_provider_id_hypervisor_providers_id_fk" FOREIGN KEY ("provider_id") REFERENCES "public"."hypervisor_providers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_reseller_id_resellers_id_fk" FOREIGN KEY ("reseller_id") REFERENCES "public"."resellers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_deliveries" ADD CONSTRAINT "webhook_deliveries_event_id_webhook_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."webhook_events"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_deliveries" ADD CONSTRAINT "webhook_deliveries_endpoint_id_webhook_endpoints_id_fk" FOREIGN KEY ("endpoint_id") REFERENCES "public"."webhook_endpoints"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_endpoints" ADD CONSTRAINT "webhook_endpoints_reseller_id_resellers_id_fk" FOREIGN KEY ("reseller_id") REFERENCES "public"."resellers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "audit_events_tenant_id_created_at_index" ON "audit_events" USING btree ("tenant_id","created_at");--> statement-breakpoint
CREATE INDEX "audit_events_reseller_id_created_at_index" ON "audit_events" USING btree ("reseller_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "customers_reseller_id_external_ref_index" ON "customers" USING btree ("reseller_id","external_ref");--> statement-breakpoint
CREATE INDEX "customers_tenant_id_index" ON "customers" USING btree ("tenant_id");--> statement-breakpoint
CREATE UNIQUE INDEX "deposits_gateway_gateway_order_id_index" ON "deposits" USING btree ("gateway","gateway_order_id");--> statement-breakpoint
CREATE UNIQUE INDEX "deposits_gateway_gateway_payment_id_index" ON "deposits" USING btree ("gateway","gateway_payment_id");--> statement-breakpoint
CREATE UNIQUE INDEX "deposits_reseller_id_external_ref_index" ON "deposits" USING btree ("reseller_id","external_ref");--> statement-breakpoint
CREATE UNIQUE INDEX "deposits_bank_reference_uq" ON "deposits" USING btree ("tenant_id","bank_reference") WHERE bank_reference is not null and status <> 'REJECTED';--> statement-breakpoint
CREATE INDEX "deposits_tenant_id_status_index" ON "deposits" USING btree ("tenant_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "external_product_mappings_connection_id_external_product_id_index" ON "external_product_mappings" USING btree ("connection_id","external_product_id");--> statement-breakpoint
CREATE UNIQUE INDEX "hypervisor_networks_provider_id_node_external_id_index" ON "hypervisor_networks" USING btree ("provider_id","node","external_id");--> statement-breakpoint
CREATE UNIQUE INDEX "hypervisor_nodes_provider_id_name_index" ON "hypervisor_nodes" USING btree ("provider_id","name");--> statement-breakpoint
CREATE UNIQUE INDEX "hypervisor_providers_tenant_id_name_index" ON "hypervisor_providers" USING btree ("tenant_id","name");--> statement-breakpoint
CREATE UNIQUE INDEX "hypervisor_storages_provider_id_node_external_id_index" ON "hypervisor_storages" USING btree ("provider_id","node","external_id");--> statement-breakpoint
CREATE UNIQUE INDEX "integration_connections_reseller_id_name_index" ON "integration_connections" USING btree ("reseller_id","name");--> statement-breakpoint
CREATE UNIQUE INDEX "ip_addresses_tenant_id_address_index" ON "ip_addresses" USING btree ("tenant_id","address");--> statement-breakpoint
CREATE INDEX "ip_addresses_pool_id_status_index" ON "ip_addresses" USING btree ("pool_id","status");--> statement-breakpoint
CREATE INDEX "ip_addresses_service_id_index" ON "ip_addresses" USING btree ("service_id");--> statement-breakpoint
CREATE INDEX "ip_addresses_order_id_index" ON "ip_addresses" USING btree ("order_id");--> statement-breakpoint
CREATE UNIQUE INDEX "ip_pools_tenant_id_name_index" ON "ip_pools" USING btree ("tenant_id","name");--> statement-breakpoint
CREATE UNIQUE INDEX "ledger_accounts_tenant_id_code_currency_index" ON "ledger_accounts" USING btree ("tenant_id","code","currency");--> statement-breakpoint
CREATE INDEX "ledger_accounts_reseller_id_index" ON "ledger_accounts" USING btree ("reseller_id");--> statement-breakpoint
CREATE INDEX "ledger_entries_account_id_created_at_index" ON "ledger_entries" USING btree ("account_id","created_at");--> statement-breakpoint
CREATE INDEX "ledger_entries_transaction_id_index" ON "ledger_entries" USING btree ("transaction_id");--> statement-breakpoint
CREATE UNIQUE INDEX "ledger_transactions_tenant_id_idempotency_key_index" ON "ledger_transactions" USING btree ("tenant_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "ledger_transactions_reseller_id_created_at_index" ON "ledger_transactions" USING btree ("reseller_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "locations_tenant_id_code_index" ON "locations" USING btree ("tenant_id","code");--> statement-breakpoint
CREATE INDEX "order_events_order_id_created_at_index" ON "order_events" USING btree ("order_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "orders_tenant_id_reseller_id_idempotency_key_index" ON "orders" USING btree ("tenant_id","reseller_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "orders_tenant_id_status_index" ON "orders" USING btree ("tenant_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "os_templates_provider_id_external_id_index" ON "os_templates" USING btree ("provider_id","external_id");--> statement-breakpoint
CREATE UNIQUE INDEX "payment_events_gateway_event_id_index" ON "payment_events" USING btree ("gateway","event_id");--> statement-breakpoint
CREATE UNIQUE INDEX "price_lists_tenant_id_name_index" ON "price_lists" USING btree ("tenant_id","name");--> statement-breakpoint
CREATE UNIQUE INDEX "prices_price_list_id_product_id_cycle_index" ON "prices" USING btree ("price_list_id","product_id","cycle");--> statement-breakpoint
CREATE UNIQUE INDEX "product_placements_product_id_location_id_index" ON "product_placements" USING btree ("product_id","location_id");--> statement-breakpoint
CREATE UNIQUE INDEX "products_tenant_id_sku_index" ON "products" USING btree ("tenant_id","sku");--> statement-breakpoint
CREATE UNIQUE INDEX "service_renewals_service_id_idempotency_key_index" ON "service_renewals" USING btree ("service_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "services_tenant_id_status_index" ON "services" USING btree ("tenant_id","status");--> statement-breakpoint
CREATE INDEX "services_reseller_id_index" ON "services" USING btree ("reseller_id");--> statement-breakpoint
CREATE UNIQUE INDEX "users_tenant_id_email_index" ON "users" USING btree ("tenant_id","email");--> statement-breakpoint
CREATE UNIQUE INDEX "webhook_deliveries_event_id_endpoint_id_index" ON "webhook_deliveries" USING btree ("event_id","endpoint_id");--> statement-breakpoint
CREATE INDEX "webhook_events_reseller_id_created_at_index" ON "webhook_events" USING btree ("reseller_id","created_at");