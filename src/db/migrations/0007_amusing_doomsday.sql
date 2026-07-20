ALTER TABLE "patients" ADD COLUMN "booking_nudge_offered" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "services" ADD COLUMN "category" text;