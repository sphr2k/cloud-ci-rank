CREATE TABLE `imports` (
	`batch_id` text PRIMARY KEY,
	`provider` text NOT NULL,
	`expected_rows` integer NOT NULL,
	`etag` text,
	`digest` text NOT NULL,
	`started_at` text NOT NULL
);
