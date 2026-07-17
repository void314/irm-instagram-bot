CREATE TABLE IF NOT EXISTS "documents" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
	"title" text NOT NULL,
	"source" text NOT NULL DEFAULT 'manual',
	"metadata" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "chunks" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
	"document_id" bigint NOT NULL REFERENCES "documents"("id") ON DELETE CASCADE,
	"index" integer NOT NULL,
	"text" text NOT NULL,
	"embedding" vector(3072),
	"metadata" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL
);
