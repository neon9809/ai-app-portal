CREATE TABLE `app_runs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`app_id` text NOT NULL,
	`user_id` integer,
	`ts` integer NOT NULL,
	`duration_ms` integer NOT NULL,
	`status` text NOT NULL,
	`error` text,
	`logs` text
);
--> statement-breakpoint
CREATE INDEX `app_runs_app_idx` ON `app_runs` (`app_id`,`ts`);