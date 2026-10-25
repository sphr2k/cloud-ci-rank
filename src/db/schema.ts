import { sqliteTable, text, integer, real, index } from 'drizzle-orm/sqlite-core';
import { createInsertSchema } from 'drizzle-orm/zod';

export const sources = sqliteTable('sources', {
  provider: text('provider', { enum: ['AWS', 'GCP', 'AZURE', 'HCLOUD', 'OVH', 'UPCLOUD', 'VULTR', 'ALICLOUD'] }).primaryKey(),
  etag: text('etag'),
  contentDigest: text('content_digest'),
  activeBatch: text('active_batch'),
  checkedAt: text('checked_at').notNull(),
  changedAt: text('changed_at').notNull(),
  error: text('error'),
});
export const instances = sqliteTable('instances', {
  id: text('id').primaryKey(),
  batchId: text('batch_id').notNull(),
  provider: text('provider', { enum: ['AWS', 'GCP', 'AZURE', 'HCLOUD', 'OVH', 'UPCLOUD', 'VULTR', 'ALICLOUD'] }).notNull(),
  instance: text('instance').notNull(),
  family: text('family').notNull(),
  arch: text('arch').notNull(),
  processor: text('processor').notNull(),
  vcpu: integer('vcpu').notNull(),
  ram: real('ram').notNull(),
  model: text('model', { enum: ['Spot', 'On-Demand'] }).notNull(),
  hourUsd: real('hour_usd').notNull(),
  region: text('region').notNull(),
  regionId: text('region_id'),
  countryCode: text('country_code'),
  geo: text('geo', { enum: ['eu', 'us', 'global'] }).notNull(),
  source: text('source').notNull(),
  evidence: text('evidence').notNull(),
  asof: text('asof').notNull(),
  dataClass: text('data_class').notNull(),
  interruption: text('interruption'),
  benchAll: real('bench_all'),
  benchSingle: real('bench_single'),
}, (table) => [
  index('instances_active_batch_idx').on(table.batchId),
]);
export const Instance = createInsertSchema(instances);
export type Instance = typeof instances.$inferInsert;
export type SourceRow = typeof sources.$inferSelect;

export const imports = sqliteTable('imports', {
  batchId: text('batch_id').primaryKey(),
  provider: text('provider', { enum: ['AWS', 'GCP', 'AZURE', 'HCLOUD', 'OVH', 'UPCLOUD', 'VULTR', 'ALICLOUD'] }).notNull(),
  expectedRows: integer('expected_rows').notNull(),
  etag: text('etag'),
  digest: text('digest').notNull(),
  startedAt: text('started_at').notNull()
});
