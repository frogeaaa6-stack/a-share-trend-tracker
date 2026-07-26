CREATE TABLE `dividend_strategy_accounts` (
	`strategy_key` text PRIMARY KEY NOT NULL,
	`total_capital` real NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `dividend_strategy_trades` (
	`id` text PRIMARY KEY NOT NULL,
	`strategy_key` text NOT NULL,
	`trade_date` text NOT NULL,
	`side` text NOT NULL,
	`price` real NOT NULL,
	`units` integer NOT NULL,
	`fee` real DEFAULT 0 NOT NULL,
	`note` text DEFAULT '' NOT NULL,
	`created_at` text NOT NULL
);
