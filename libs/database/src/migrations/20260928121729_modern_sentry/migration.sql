CREATE TABLE "received_events" (
	"event_id" uuid PRIMARY KEY,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "receiver_effects" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"event_id" uuid NOT NULL UNIQUE,
	"type" varchar(255) NOT NULL,
	"payload" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "receiver_effects" ADD CONSTRAINT "receiver_effects_event_id_received_events_event_id_fkey" FOREIGN KEY ("event_id") REFERENCES "received_events"("event_id");