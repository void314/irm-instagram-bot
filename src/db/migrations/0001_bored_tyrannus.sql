CREATE TABLE "comments" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "comments_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"comment_id" text NOT NULL,
	"media_id" text,
	"sender_id" text NOT NULL,
	"sender_username" text,
	"text" text,
	"parent_id" text,
	"from_business" boolean DEFAULT false NOT NULL,
	"is_question" boolean DEFAULT false,
	"answer_text" text,
	"metadata" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "comments_comment_id_unique" UNIQUE("comment_id")
);
