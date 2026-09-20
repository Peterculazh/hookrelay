CREATE TABLE "events" (
	"id" uuid PRIMARY KEY,
	"type" varchar(255) NOT NULL,
	"payload" jsonb NOT NULL,
	"target_url" varchar(255) NOT NULL,
	"status" varchar(255) NOT NULL,
	"created_at" timestamp NOT NULL,
	"delivered_at" timestamp
);
