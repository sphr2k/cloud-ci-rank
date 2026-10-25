CREATE TABLE `instances` (
	`id` text PRIMARY KEY,
	`batch_id` text NOT NULL,
	`provider` text NOT NULL,
	`instance` text NOT NULL,
	`family` text NOT NULL,
	`arch` text NOT NULL,
	`processor` text NOT NULL,
	`vcpu` integer NOT NULL,
	`ram` real NOT NULL,
	`model` text NOT NULL,
	`hour_usd` real NOT NULL,
	`region` text NOT NULL,
	`geo` text NOT NULL,
	`source` text NOT NULL,
	`evidence` text NOT NULL,
	`asof` text NOT NULL,
	`data_class` text NOT NULL,
	`interruption` text
);
--> statement-breakpoint
CREATE TABLE `sources` (
	`provider` text PRIMARY KEY,
	`etag` text,
	`content_digest` text,
	`active_batch` text,
	`checked_at` text NOT NULL,
	`changed_at` text NOT NULL,
	`error` text
);
--> statement-breakpoint
CREATE INDEX `instances_active_batch_idx` ON `instances` (`batch_id`);