CREATE TABLE `app_acl` (
	`app_id` text PRIMARY KEY NOT NULL,
	`allow_group_ids` text DEFAULT '[]' NOT NULL,
	`allow_user_ids` text DEFAULT '[]' NOT NULL,
	FOREIGN KEY (`app_id`) REFERENCES `apps`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `user_group_members` (
	`group_id` integer NOT NULL,
	`user_id` integer NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`group_id`) REFERENCES `user_groups`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `user_groups` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`note` text DEFAULT '' NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `user_groups_name_unique` ON `user_groups` (`name`);--> statement-breakpoint
ALTER TABLE `apps` ADD `kind` text DEFAULT 'upstream' NOT NULL;--> statement-breakpoint
ALTER TABLE `apps` ADD `owner_user_id` integer;