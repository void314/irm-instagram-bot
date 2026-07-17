ALTER TABLE "messages" ALTER COLUMN "embedding" TYPE vector(3072);
--> statement-breakpoint
ALTER TABLE "accounts" ADD COLUMN "token_encrypted" text;
--> statement-breakpoint
ALTER TABLE "accounts" ADD COLUMN "token_iv" text;
--> statement-breakpoint
ALTER TABLE "accounts" ADD COLUMN "last_refresh_at" timestamp;
--> statement-breakpoint
ALTER TABLE "accounts" ADD COLUMN "refresh_error" text;
--> statement-breakpoint
ALTER TABLE "accounts" DROP COLUMN "access_token";
