CREATE TABLE `redeem_codes` (
	`code` text PRIMARY KEY NOT NULL,
	`batch_id` text NOT NULL,
	`kind` text NOT NULL,
	`tokens` integer,
	`plan_id` integer,
	`status` text DEFAULT 'unused' NOT NULL,
	`note` text,
	`expires_at` integer,
	`created_by` integer,
	`created_at` integer NOT NULL,
	`used_by` integer,
	`used_at` integer
);
