CREATE TABLE `oidc_states` (
	`state` text PRIMARY KEY NOT NULL,
	`nonce` text NOT NULL,
	`code_verifier` text NOT NULL,
	`ip` text,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL
);
--> statement-breakpoint
ALTER TABLE `users` ADD `subject` text;--> statement-breakpoint
CREATE UNIQUE INDEX `users_subject_uq` ON `users` (`subject`) WHERE subject IS NOT NULL;