CREATE TABLE `apps` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`icon` text,
	`category` text DEFAULT '未分类' NOT NULL,
	`visibility` text DEFAULT 'login' NOT NULL,
	`pass_user` integer DEFAULT false NOT NULL,
	`upstream` text NOT NULL,
	`url_secret_enc` text,
	`enabled` integer DEFAULT true NOT NULL,
	`sort` integer DEFAULT 0 NOT NULL,
	`health_state` text DEFAULT 'unknown' NOT NULL,
	`last_probe_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
