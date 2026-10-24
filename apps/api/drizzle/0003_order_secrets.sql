ALTER TABLE "orders" ADD COLUMN "encrypted_secret" text;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "ssh_keys" text[] DEFAULT '{}'::text[] NOT NULL;