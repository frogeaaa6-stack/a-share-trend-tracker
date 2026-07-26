CREATE TABLE `market_bars` (
	`run_id` text NOT NULL,
	`date` text NOT NULL,
	`open` real NOT NULL,
	`high` real NOT NULL,
	`low` real NOT NULL,
	`close` real NOT NULL,
	`volume` real NOT NULL,
	`amount` real,
	PRIMARY KEY(`run_id`, `date`)
);
--> statement-breakpoint
CREATE TABLE `market_datasets` (
	`id` text PRIMARY KEY NOT NULL,
	`symbol` text NOT NULL,
	`adjustment` text NOT NULL,
	`version` integer NOT NULL,
	`run_id` text NOT NULL,
	`hash` text NOT NULL,
	`created_at` text NOT NULL,
	`quality_json` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `market_issues` (
	`id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`code` text NOT NULL,
	`severity` text NOT NULL,
	`date` text,
	`message` text NOT NULL,
	`details_json` text
);
--> statement-breakpoint
CREATE TABLE `market_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`symbol` text NOT NULL,
	`adjustment` text NOT NULL,
	`started_at` text NOT NULL,
	`completed_at` text,
	`status` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `market_source_snapshots` (
	`id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`provider` text NOT NULL,
	`fetched_at` text NOT NULL,
	`request_url` text NOT NULL,
	`payload_json` text,
	`payload_hash` text,
	`error` text
);
