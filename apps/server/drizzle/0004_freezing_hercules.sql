CREATE TABLE `llm_app_tokens` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`token_hash` text NOT NULL,
	`app_id` text NOT NULL,
	`name` text DEFAULT '' NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`per_minute_limit` integer,
	`created_at` integer NOT NULL,
	`last_used_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `llm_app_tokens_token_hash_unique` ON `llm_app_tokens` (`token_hash`);--> statement-breakpoint
CREATE INDEX `llm_tokens_app_idx` ON `llm_app_tokens` (`app_id`);--> statement-breakpoint
CREATE TABLE `llm_balance_cache` (
	`user_id` integer PRIMARY KEY NOT NULL,
	`balance` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `llm_ledger` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`ts` integer NOT NULL,
	`user_id` integer,
	`app_id` text,
	`kind` text NOT NULL,
	`model` text,
	`prompt_tokens` integer,
	`completion_tokens` integer,
	`delta` integer NOT NULL,
	`latency_ms` integer,
	`status` text DEFAULT 'ok' NOT NULL,
	`request_id` text,
	`note` text
);
--> statement-breakpoint
CREATE INDEX `llm_ledger_user_idx` ON `llm_ledger` (`user_id`,`ts`);--> statement-breakpoint
CREATE INDEX `llm_ledger_app_idx` ON `llm_ledger` (`app_id`,`ts`);--> statement-breakpoint
CREATE TABLE `llm_routes` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`model` text NOT NULL,
	`upstream_id` integer NOT NULL,
	`upstream_model` text NOT NULL,
	`multiplier` integer DEFAULT 100 NOT NULL,
	`priority` integer DEFAULT 100 NOT NULL,
	`weight` integer DEFAULT 100 NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`upstream_id`) REFERENCES `llm_upstreams`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `llm_routes_model_idx` ON `llm_routes` (`model`);--> statement-breakpoint
CREATE TABLE `llm_upstreams` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`base_url` text NOT NULL,
	`api_key_enc` text NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`created_at` integer NOT NULL
);
