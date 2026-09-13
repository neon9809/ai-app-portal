CREATE TABLE `membership_plans` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`group_id` integer NOT NULL,
	`duration_days` integer NOT NULL,
	`price_fen` integer DEFAULT 0 NOT NULL,
	`token_grant` integer DEFAULT 0 NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`group_id`) REFERENCES `user_groups`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `membership_plans_name_unique` ON `membership_plans` (`name`);--> statement-breakpoint
CREATE TABLE `topup_orders` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` integer NOT NULL,
	`kind` text NOT NULL,
	`plan_id` integer,
	`tokens` integer,
	`price_fen` integer NOT NULL,
	`channel` text DEFAULT 'manual' NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`note` text,
	`created_at` integer NOT NULL,
	`paid_at` integer,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `topup_orders_user_idx` ON `topup_orders` (`user_id`,`created_at`);--> statement-breakpoint
ALTER TABLE `llm_routes` ADD `cost_per_1k` integer DEFAULT 0 NOT NULL;