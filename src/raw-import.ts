import { z } from 'zod';
import { type } from 'arktype';
import type { D1Database } from '@cloudflare/workers-types';
import { SnapshotConflictError, IncompleteSnapshotError, SnapshotNotFoundError } from 'supersqlite';
import { KeeperStored, snapshotStore } from './raw-schema';
import { COUNTRIES, KEEPER_VENDORS, keeperVendor } from './keeper';
import type { DataEnvelope, Offer } from './pricing';

const providerSchema = z.enum(KEEPER_VENDORS);
const beginSchema = z.object({
  provider: providerSchema,
  digest: z.string().regex(/^[a-f0-9]{64}$/),
  expectedRows: z.number().int().min(1).max(100000)
});
const chunkSchema = z.object({
  batchId: z.string().min(10).max(100),
  offset: z.number().int().nonnegative(),
  docs: z.array(z.unknown()).min(1).max(20)
});
const commitSchema = z.object({ batchId: z.string().min(10).max(100) });
const countries = new Set<string>(COUNTRIES);

/** Before the additive D1 migration is applied, legacy reads and scheduled
 * refresh must remain operational instead of failing with a generic 500. */
async function hasRawSchema(db: D1Database): Promise<boolean> {
  const row=await db.prepare(`SELECT COUNT(*) AS total FROM sqlite_master
    WHERE type = 'table' AND name IN ('keeper_documents','keeper_batches','keeper_heads')`)
    .first<{total:number}>();
  return row?.total === 3;
}
const HEADER = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'public,max-age=120,s-maxage=300' };

async function payload(request: Request): Promise<unknown> {
  // Validate size even for chunked-transfer and dishonest Content-Length headers.
  const bytes = await request.arrayBuffer();
  if (bytes.byteLength > 64_000) throw new RangeError('Payload too large');
  return JSON.parse(new TextDecoder().decode(bytes));
}

function parseKeeperDoc(input: unknown, provider: string): typeof KeeperStored.inferIn {
  const parsed = KeeperStored(input);
  if (parsed instanceof type.errors) throw new TypeError(`Invalid Keeper source document: ${parsed.summary}`);
  if (parsed.kind === 'offer') {
    if (parsed.offer.provider !== provider) throw new TypeError('Materialized offer provider does not match import namespace');
    return parsed;
  }
  if (!countries.has(parsed.country) || keeperVendor(parsed.raw) !== provider ||
      (provider === 'AWS' && (!parsed.awsRegion || parsed.awsRegion.country !== parsed.country)) ||
      (provider !== 'AWS' && parsed.awsRegion)) {
    throw new TypeError('Keeper country/provider does not match import namespace');
  }
  return parsed;
}

export async function rawSources(db: D1Database): Promise<Response> {
  if (!await hasRawSchema(db)) return Response.json({error:'Raw snapshot schema not provisioned',migrationRequired:true},{status:404});
  const store = snapshotStore(db);
  const heads = await store.listHeads();
  return Response.json(Object.fromEntries(heads.map(h => [h.namespace, {
    digest: h.digest, batchId: h.batchId, checkedAt: h.checkedAt, changedAt: h.changedAt
  }])), { headers: HEADER });
}

export async function rawStatus(db: D1Database): Promise<Response> {
  if (!await hasRawSchema(db)) return Response.json({
    ready:false,migrationRequired:true,present:[],missing:[...KEEPER_VENDORS]
  }, {headers:HEADER});
  const store = snapshotStore(db);
  const heads = await store.listHeads();
  return Response.json({
    ready: KEEPER_VENDORS.every(v => heads.some(h => h.namespace === v)),
    present: heads.map(h => h.namespace),
    missing: KEEPER_VENDORS.filter(v => !heads.some(h => h.namespace === v))
  }, { headers: HEADER });
}

/** Authorized ingestion; no direct D1 SQL is required by the application. */
export async function rawImport(db: D1Database, path: string, request: Request): Promise<Response> {
  if (!await hasRawSchema(db)) return Response.json({
    error:'Raw snapshot schema not provisioned',migrationRequired:true
  }, {status:409});
  const store = snapshotStore(db);
  try {
    if (path === '/api/raw-import/begin') {
      const body = beginSchema.parse(await payload(request));
      const next = await store.begin(body.provider, body.digest, body.expectedRows);
      return Response.json(next);
    }
    if (path === '/api/raw-import/chunk') {
      const body = chunkSchema.parse(await payload(request));
      const batch = await store.import(body.batchId);
      const docs = body.docs.map(doc => parseKeeperDoc(doc, batch.namespace));
      const result = await store.append(body.batchId, body.offset, docs);
      return Response.json({ status: 'accepted', ...result });
    }
    if (path === '/api/raw-import/status') {
      const body = commitSchema.parse(await payload(request));
      const batch = await store.import(body.batchId);
      return Response.json({ ...batch, count: await store.countBatch(body.batchId) });
    }
    if (path === '/api/raw-import/prune') {
      const body = commitSchema.parse(await payload(request));
      return Response.json({ status: 'pruned', count: await store.prune(body.batchId) });
    }
    if (path === '/api/raw-import/commit') {
      const body = commitSchema.parse(await payload(request));
      const batch = await store.import(body.batchId);
      const actual = await store.countBatch(body.batchId);
      if (actual !== batch.expectedRows) throw new IncompleteSnapshotError(actual, batch.expectedRows);
      const [raw, offers] = await Promise.all([
        store.readBatchPage(body.batchId, {kind: 'raw', limit: 1}),
        store.readBatchPage(body.batchId, {kind: 'offer', limit: 1})
      ]);
      if (!raw.documents.length || !offers.documents.length) {
        throw new SnapshotConflictError('Snapshot requires both raw source and materialized offer documents');
      }
      const result = await store.publish(body.batchId);
      const count = await store.countBatch(body.batchId);
      // Retain previous batches for rollback and safe in-flight reads.
      return Response.json({ status: result.status, provider: result.head.namespace,
        count, batchId: body.batchId, previousBatchId: result.previousBatchId });
    }
    return new Response('Not Found', {status: 404});
  } catch (error) {
    if (error instanceof z.ZodError) return Response.json({ error: 'Invalid request', issues: error.issues }, {status: 400});
    if (error instanceof IncompleteSnapshotError) return Response.json({ error: error.message, actual: error.actual, expected: error.expected }, {status: 409});
    if (error instanceof SnapshotConflictError) return Response.json({ error: error.message }, {status: 409});
    if (error instanceof SnapshotNotFoundError) return Response.json({ error: error.message }, {status: 404});
    if (error instanceof TypeError || error instanceof RangeError || error instanceof SyntaxError) {
      return Response.json({ error: error.message }, {status: 400});
    }
    throw error;
  }
}

/** A strict, explicit read cutover: only serve raw snapshots if all providers are ready. */
export async function rawPrices(db: D1Database, request: Request): Promise<Response | null> {
  if (!await hasRawSchema(db)) return null;
  const store = snapshotStore(db);
  const heads = await store.listHeads();
  if (!KEEPER_VENDORS.every(v => heads.some(h => h.namespace === v))) return null;
  const etag = '"' + heads.map(h => `${h.namespace}:${h.batchId}`).sort().join('|') + '"';
  if (request.headers.get('If-None-Match') === etag) return new Response(null, {status: 304, headers: {etag}});
  const offers: Offer[] = [];
  for (const head of heads) {
    let cursor: string | undefined;
    do {
      const page = await store.readBatchPage(head.batchId, { limit: 300, cursor, kind: 'offer' });
      for (const entry of page.documents) if (entry.kind === 'offer') offers.push(entry.offer);
      if (offers.length > 10000) throw new RangeError('Materialized Keeper offers exceed configured Worker read limit');
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
  }
  if (!offers.length) throw new Error('Materialized Keeper offers are empty');
  // Avoid fetching and parsing potentially hundreds of megabytes of raw source
  // documents per public request. Raw JSON remains available for audits.
  const data: DataEnvelope = {
    updatedAt: heads.map(h => h.changedAt).sort().at(-1) ?? '',
    providers: Object.fromEntries(heads.map(h => [h.namespace, {
      checkedAt: h.checkedAt, changedAt: h.changedAt,
      records: offers.filter(x => x.provider === h.namespace).length
    }])),
    offers
  };
  return Response.json(data, { headers: {...HEADER, etag} });
}
