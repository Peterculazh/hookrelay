CREATE TYPE "delivery_attempt_status" AS ENUM('in_progress', 'succeeded', 'failed');--> statement-breakpoint
CREATE TABLE "delivery_attempts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"event_id" uuid NOT NULL,
	"status" "delivery_attempt_status" DEFAULT 'in_progress'::"delivery_attempt_status" NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"http_status" integer,
	"error_code" varchar(50),
	"error_message" text
);
--> statement-breakpoint
CREATE INDEX "delivery_attempts_event_id_idx" ON "delivery_attempts" ("event_id");--> statement-breakpoint
ALTER TABLE "delivery_attempts" ADD CONSTRAINT "delivery_attempts_event_id_events_id_fkey" FOREIGN KEY ("event_id") REFERENCES "events"("id") ON DELETE CASCADE;