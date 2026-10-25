-- Additive raw Keeper snapshots. Existing instances/sources/imports remain untouched
-- until operators explicitly opt into READ_KEEPER_SNAPSHOTS=1 after backfill.
CREATE TABLE IF NOT EXISTS "keeper_documents" (
  id TEXT PRIMARY KEY,
  data TEXT NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_keeper_documents_batch" ON "keeper_documents" (json_extract(data, '$.json.batchId'));
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_keeper_documents_batch_kind" ON "keeper_documents" (
  json_extract(data, '$.json.batchId'), json_extract(data, '$.json.value.kind')
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "keeper_batches" (
  id TEXT PRIMARY KEY,
  namespace TEXT NOT NULL,
  digest TEXT NOT NULL,
  expected_rows INTEGER NOT NULL,
  parent_batch_id TEXT,
  started_at TEXT NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_keeper_batches_namespace" ON "keeper_batches" (namespace);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "keeper_heads" (
  namespace TEXT PRIMARY KEY,
  batch_id TEXT NOT NULL,
  digest TEXT NOT NULL,
  checked_at TEXT NOT NULL,
  changed_at TEXT NOT NULL
);
