CREATE TABLE `trusted_signing_keys` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`key_id` text NOT NULL,
	`name` text DEFAULT '' NOT NULL,
	`public_key` text NOT NULL,
	`builtin` integer DEFAULT false NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `trusted_signing_keys_key_id_unique` ON `trusted_signing_keys` (`key_id`);--> statement-breakpoint
ALTER TABLE `apps` ADD `signature_status` text;