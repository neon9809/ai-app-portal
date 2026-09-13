ALTER TABLE `apps` ADD `manifest_json` text;--> statement-breakpoint
ALTER TABLE `apps` ADD `runtime_mode` text;--> statement-breakpoint
ALTER TABLE `apps` ADD `review_status` text DEFAULT 'none' NOT NULL;--> statement-breakpoint
ALTER TABLE `apps` ADD `review_note` text;--> statement-breakpoint
ALTER TABLE `apps` ADD `submitted_at` integer;--> statement-breakpoint
ALTER TABLE `apps` ADD `input_schema` text;