CREATE TABLE `invite_codes` (
	`code` text PRIMARY KEY NOT NULL,
	`created_by` integer,
	`note` text,
	`used_by` integer,
	`used_at` integer,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `registrations` (
	`id` text PRIMARY KEY NOT NULL,
	`username` text NOT NULL,
	`password_hash` text NOT NULL,
	`email` text,
	`phone` text,
	`invite_code` text,
	`ip` text,
	`attempts` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `registrations_created_idx` ON `registrations` (`created_at`);--> statement-breakpoint
CREATE TABLE `verification_codes` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`channel` text NOT NULL,
	`target` text NOT NULL,
	`purpose` text NOT NULL,
	`code_hash` text NOT NULL,
	`ip` text,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`consumed_at` integer
);
--> statement-breakpoint
CREATE INDEX `verification_codes_target_idx` ON `verification_codes` (`channel`,`target`,`created_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `users_email_uq` ON `users` (`email`) WHERE email IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `users_phone_uq` ON `users` (`phone`) WHERE phone IS NOT NULL;