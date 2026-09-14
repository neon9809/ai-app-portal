CREATE TABLE `app_env_vars` (
	`app_id` text NOT NULL,
	`name` text NOT NULL,
	`value_enc` text NOT NULL,
	`is_secret` integer DEFAULT false NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`app_id`, `name`),
	FOREIGN KEY (`app_id`) REFERENCES `apps`(`id`) ON UPDATE NO ACTION ON DELETE CASCADE
);
