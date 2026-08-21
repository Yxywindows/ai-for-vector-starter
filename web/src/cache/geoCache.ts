/** Multi-level cache for map tiles and GeoJSON feature responses.
 *
 * Tiers, checked in order: an in-memory LRU Map (fast, small, survives
 * only for the page's lifetime) -> IndexedDB (slower, large, survives
 * reloads) -> network (with conditional revalidation via ETag/If-None-Match).
 *
 * A hit at any tier returns immediately. If the cached entry is older than
 * `FRESH_MS` it also fires a single background revalidation (stale-while-
 * revalidate): 304 refreshes `storedAt`, 200 replaces the value, a network
 * error is swallowed so offline browsing keeps serving what's cached.
 *
 * Concurrent requests for the same key share one in-flight network fetch
 * (dedupe). Callers may pass their own AbortSignal; the shared underlying
 * fetch is only aborted once every joined caller has aborted theirs — an
 * aborting caller rejects immediately with a DOMException('AbortError'),
 * independent of whether the shared fetch itself keeps running for others.
 *
 * All module state is a singleton (there is exactly one geo cache per
 * page). `resetForTests()` drops all of it for test isolation.
 */

import { ApiError } from '../api/client'
import { openGeoDB } from './idb'
import type { GeoDB, StoredEntry } from './idb'

const FRESH_MS = 60_000
const MEM_BUDGET = 32 * 1024 * 1024
const IDB_BUDGET = 256 * 1024 * 1024
const IDB_EVICT_TO = 224 * 1024 * 1024
const LAST_ACCESS_THROTTLE_MS = 60_000
const HIT_LATENCY_SAMPLES = 500

type CacheStore = 'tiles' | 'features'

export interface GeoCacheMetrics {
  memHits: number
  idbHits: number
  misses: number
  revalidated304: number
  revalidated200: number
  dedupedRequests: number
  evictedBytes: number
  idbErrors: number
  networkBytes: number
  cachedBytesServed: number
  hitLatencyMs: { mem: number[]; idb: number[] }
}

export interface FetchResult<T> {
  value: T
  source: 'mem' | 'idb' | 'network'
}

function freshMetrics(): GeoCacheMetrics {
  return {
    memHits: 0,
    idbHits: 0,
    misses: 0,
    revalidated304: 0,
    revalidated200: 0,
    dedupedRequests: 0,
    evictedBytes: 0,
    idbErrors: 0,
    networkBytes: 0,
    cachedBytesServed: 0,
    hitLatencyMs: { mem: [], idb: [] },
  }
}

// --- singleton state -------------------------------------------------

let metrics: GeoCacheMetrics = freshMetrics()
const mem = new Map<string, StoredEntry>()
let memBytes = 0

let dbPromise: Promise<GeoDB | null> | null = null
function getDb(): Promise<GeoDB | null> {
  dbPromise ??= openGeoDB(() => {
    metrics.idbErrors++
  })
  return dbPromise
}

interface InFlightEntry {
  controller: AbortController
  networkPromise: Promise<RawFetch>
  totalJoined: number
  abortedJoined: number
}
const inFlight = new Map<string, InFlightEntry>()

// Keys currently running a background SWR revalidation, so a second stale
// hit for the same key while one is already in flight doesn't fire another.
const revalidating = new Set<string>()
// Outstanding revalidation promises, exposed via `_pendingRevalidations` so
// tests can await determinism instead of racing background work.
const pendingRevalidations = new Set<Promise<void>>()

export function resetForTests(): void {
  metrics = freshMetrics()
  mem.clear()
  memBytes = 0
  dbPromise = null
  inFlight.clear()
  revalidating.clear()
  pendingRevalidations.clear()
}

export function getMetrics(): GeoCacheMetrics {
  return metrics
}

export function _pendingRevalidations(): Promise<void> {
  return Promise.allSettled([...pendingRevalidations]).then(() => undefined)
}

// --- memory tier (Map-as-LRU: delete+re-set moves an entry to the end) --

function setMem(key: string, entry: StoredEntry): void {
  const existing = mem.get(key)
  if (existing) {
    mem.delete(key)
    memBytes -= existing.size
  }
  mem.set(key, entry)
  memBytes += entry.size
  while (memBytes > MEM_BUDGET && mem.size > 0) {
    const oldestKey = mem.keys().next().value
    if (oldestKey === undefined) break
    const oldest = mem.get(oldestKey)
    mem.delete(oldestKey)
    if (oldest) memBytes -= oldest.size
  }
}

async function maybeEvictIdb(db: GeoDB, store: CacheStore): Promise<void> {
  const total = await db.totalBytes(store)
  if (total > IDB_BUDGET) {
    metrics.evictedBytes += await db.evictLRU(store, IDB_EVICT_TO)
  }
}

interface TierHit {
  entry: StoredEntry
  source: 'mem' | 'idb'
}

async function readTier(store: CacheStore, key: string): Promise<TierHit | null> {
  const memEntry = mem.get(key)
  if (memEntry) {
    // Move to the end (most-recently-used) for the Map-as-LRU scheme.
    mem.delete(key)
    mem.set(key, memEntry)
    return { entry: memEntry, source: 'mem' }
  }
  const db = await getDb()
  if (!db) return null
  const idbEntry = await db.get(store, key)
  if (!idbEntry) return null
  setMem(key, idbEntry)
  return { entry: idbEntry, source: 'idb' }
}

function recordHitLatency(source: 'mem' | 'idb', ms: number): void {
  const samples = metrics.hitLatencyMs[source]
  samples.push(ms)
  if (samples.length > HIT_LATENCY_SAMPLES) samples.shift()
}

// lastAccess is updated on the mem copy every hit, but only written through
// to IDB at most once per LAST_ACCESS_THROTTLE_MS per key.
async function bumpLastAccess(store: CacheStore, key: string, entry: StoredEntry): Promise<void> {
  const now = Date.now()
  const updated: StoredEntry = { ...entry, lastAccess: now }
  mem.set(key, updated)
  if (now - entry.lastAccess > LAST_ACCESS_THROTTLE_MS) {
    const db = await getDb()
    if (db) await db.put(store, updated)
  }
}

// --- network fetch + parsing -------------------------------------------

interface RawFetch {
  status: 200 | 204 | 304
  value: unknown
  etag: string | null
  size: number
}

function isErrorEnvelope(
  value: unknown,
): value is { error: { code: string; message: string; details: unknown } } {
  if (typeof value !== 'object' || value === null) return false
  const candidate = (value as { error?: unknown }).error
  return typeof candidate === 'object' && candidate !== null && 'code' in candidate
}

async function doFetch(
  url: string,
  ifNoneMatch: string | null,
  store: CacheStore,
  signal?: AbortSignal,
): Promise<RawFetch> {
  const init: RequestInit = {}
  if (signal) init.signal = signal
  if (ifNoneMatch) init.headers = { 'If-None-Match': ifNoneMatch }

  const response = await fetch(url, init)
  const etag = response.headers.get('ETag')

  if (response.status === 304) {
    return { status: 304, value: undefined, etag: etag ?? ifNoneMatch, size: 0 }
  }
  if (response.status === 204) {
    return { status: 204, value: null, etag, size: 0 }
  }
  if (!response.ok) {
    let payload: unknown = null
    try {
      payload = await response.json()
    } catch {
      // non-JSON error body: fall through to the generic ApiError below
    }
    if (isErrorEnvelope(payload)) {
      throw new ApiError(
        response.status,
        payload.error.code,
        payload.error.message,
        payload.error.details,
      )
    }
    throw new ApiError(
      response.status,
      'http_error',
      `Request failed with status ${response.status}`,
      payload,
    )
  }

  if (store === 'tiles') {
    const buf = await response.arrayBuffer()
    return { status: 200, value: buf, etag, size: buf.byteLength }
  }
  const text = await response.text()
  const size = new TextEncoder().encode(text).length
  return { status: 200, value: JSON.parse(text) as unknown, etag, size }
}

async function persistFetched(
  store: CacheStore,
  key: string,
  layerId: string,
  raw: RawFetch,
): Promise<void> {
  const now = Date.now()
  const entry: StoredEntry = {
    key,
    value: raw.value,
    etag: raw.etag,
    storedAt: now,
    lastAccess: now,
    size: raw.size,
    layerId,
  }
  setMem(key, entry)
  const db = await getDb()
  if (db) {
    await db.put(store, entry)
    await maybeEvictIdb(db, store)
  }
}

// --- dedupe + abort refcounting ------------------------------------------

// Wraps the shared network promise for one joined caller. A caller without
// a signal simply shares the network promise directly. A caller with a
// signal gets its own wrapper that rejects the instant *its* signal aborts
// (independent of the shared fetch), while counting toward the refcount
// that decides whether the underlying fetch itself gets aborted.
function joinCaller(entry: InFlightEntry, signal?: AbortSignal): Promise<RawFetch> {
  if (!signal) return entry.networkPromise

  const onAbort = (): void => {
    entry.abortedJoined++
    if (entry.abortedJoined >= entry.totalJoined) entry.controller.abort()
  }

  if (signal.aborted) {
    onAbort()
    return Promise.reject(new DOMException('The operation was aborted.', 'AbortError'))
  }

  return new Promise<RawFetch>((resolve, reject) => {
    const abortHandler = (): void => {
      onAbort()
      signal.removeEventListener('abort', abortHandler)
      reject(new DOMException('The operation was aborted.', 'AbortError'))
    }
    signal.addEventListener('abort', abortHandler)
    entry.networkPromise.then(
      (result) => {
        signal.removeEventListener('abort', abortHandler)
        resolve(result)
      },
      (error: unknown) => {
        signal.removeEventListener('abort', abortHandler)
        reject(error)
      },
    )
  })
}

function startOrJoinFetch(
  key: string,
  url: string,
  layerId: string,
  store: CacheStore,
  signal?: AbortSignal,
): Promise<RawFetch> {
  let entry = inFlight.get(key)
  if (entry) {
    metrics.dedupedRequests++
  } else {
    const controller = new AbortController()
    const networkPromise = doFetch(url, null, store, controller.signal)
      .then(async (raw) => {
        // A miss-path fetch never sends If-None-Match, so it can only ever
        // come back 200 or 204 here (304 requires a prior etag).
        await persistFetched(store, key, layerId, raw)
        if (raw.status === 200) metrics.networkBytes += raw.size
        return raw
      })
      .finally(() => {
        inFlight.delete(key)
      })
    // Every joiner attaches its own handler via joinCaller below, but guard
    // against an unhandled rejection in the window before any of them do.
    networkPromise.catch(() => {})
    entry = { controller, networkPromise, totalJoined: 0, abortedJoined: 0 }
    inFlight.set(key, entry)
  }
  entry.totalJoined++
  return joinCaller(entry, signal)
}

// --- stale-while-revalidate ------------------------------------------

function scheduleRevalidation(
  store: CacheStore,
  key: string,
  url: string,
  layerId: string,
  entry: StoredEntry,
): void {
  if (Date.now() - entry.storedAt <= FRESH_MS) return
  if (revalidating.has(key)) return
  revalidating.add(key)

  const task: Promise<void> = revalidate(store, key, url, layerId, entry).finally(() => {
    revalidating.delete(key)
    pendingRevalidations.delete(task)
  })
  pendingRevalidations.add(task)
}

async function revalidate(
  store: CacheStore,
  key: string,
  url: string,
  layerId: string,
  entry: StoredEntry,
): Promise<void> {
  try {
    const raw = await doFetch(url, entry.etag, store)
    if (raw.status === 304) {
      metrics.revalidated304++
      const updated: StoredEntry = { ...entry, storedAt: Date.now() }
      setMem(key, updated)
      const db = await getDb()
      if (db) await db.put(store, updated)
    } else if (raw.status === 200) {
      metrics.revalidated200++
      metrics.networkBytes += raw.size
      await persistFetched(store, key, layerId, raw)
    }
  } catch {
    // Offline or a server error: keep serving whatever is already cached.
  }
}

// --- public API ---------------------------------------------------------

async function getCached<T>(
  store: CacheStore,
  key: string,
  url: string,
  layerId: string,
  signal: AbortSignal | undefined,
): Promise<FetchResult<T>> {
  const start = performance.now()
  const hit = await readTier(store, key)
  const elapsed = performance.now() - start

  if (hit) {
    recordHitLatency(hit.source, elapsed)
    if (hit.source === 'mem') metrics.memHits++
    else metrics.idbHits++
    metrics.cachedBytesServed += hit.entry.size

    await bumpLastAccess(store, key, hit.entry)
    scheduleRevalidation(store, key, url, layerId, hit.entry)

    return { value: hit.entry.value as T, source: hit.source }
  }

  metrics.misses++
  const raw = await startOrJoinFetch(key, url, layerId, store, signal)
  return { value: raw.value as T, source: 'network' }
}

/** Tiles: raw bytes (null = server 204 empty tile, cached as such). */
export function cachedTile(
  key: string,
  url: string,
  layerId: string,
  signal?: AbortSignal,
): Promise<FetchResult<ArrayBuffer | null>> {
  return getCached<ArrayBuffer | null>('tiles', key, url, layerId, signal)
}

/** Features: parsed FeatureCollection JSON (object, structured-cloned via IDB). */
export function cachedFeatures(
  key: string,
  url: string,
  layerId: string,
  signal?: AbortSignal,
): Promise<FetchResult<unknown>> {
  return getCached<unknown>('features', key, url, layerId, signal)
}

export async function invalidateLayer(layerId: string): Promise<void> {
  for (const [key, entry] of mem) {
    if (entry.layerId === layerId) {
      mem.delete(key)
      memBytes -= entry.size
    }
  }
  const db = await getDb()
  if (db) {
    await db.deleteByLayer('tiles', layerId)
    await db.deleteByLayer('features', layerId)
  }
}

/** Prefetch: no-op if already cached (either tier); otherwise fetches and
 * stores exactly like `cachedTile`, deduping with any concurrent real load
 * for the same key. Errors are swallowed — a failed prefetch just means the
 * next real load pays the network cost itself. */
export async function warmTile(
  key: string,
  url: string,
  layerId: string,
  signal?: AbortSignal,
): Promise<void> {
  if (mem.has(key)) return
  const db = await getDb()
  if (db) {
    const idbEntry = await db.get('tiles', key)
    if (idbEntry) return
  }
  try {
    await startOrJoinFetch(key, url, layerId, 'tiles', signal)
  } catch {
    // swallow: this was only ever a prefetch
  }
}
