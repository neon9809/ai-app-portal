PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_user_group_members` (
	`group_id` integer NOT NULL,
	`user_id` integer NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`group_id`, `user_id`),
	FOREIGN KEY (`group_id`) REFERENCES `user_groups`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO `__new_user_group_members`("group_id", "user_id", "created_at") SELECT "group_id", "user_id", "created_at" FROM `user_group_members`;--> statement-breakpoint
DROP TABLE `user_group_members`;--> statement-breakpoint
ALTER TABLE `__new_user_group_members` RENAME TO `user_group_members`;--> statement-breakpoint
PRAGMA foreign_keys=ON;