CREATE TABLE `market_noon_snapshots` (
  `id` text PRIMARY KEY NOT NULL,
  `symbol` text NOT NULL,
  `date` text NOT NULL,
  `snapshot_time` text NOT NULL,
  `run_id` text NOT NULL,
  `hash` text NOT NULL,
  `created_at` text NOT NULL,
  `verified` integer NOT NULL,
  `open` real NOT NULL,
  `high` real NOT NULL,
  `low` real NOT NULL,
  `close` real NOT NULL,
  `volume` real NOT NULL,
  `amount` real,
	`quality_json` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `market_noon_snapshots_unique` ON `market_noon_snapshots` (`symbol`,`date`,`snapshot_time`,`hash`);
--> statement-breakpoint
CREATE INDEX `market_noon_snapshots_latest` ON `market_noon_snapshots` (`symbol`,`date`,`snapshot_time`,`verified`,`created_at`);
