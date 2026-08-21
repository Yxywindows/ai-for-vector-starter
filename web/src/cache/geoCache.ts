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
  key: string
  layerId: string
  controller: AbortController
  networkPromise: Promise<RawFetch>
  totalJoined: number
  abortedJoined: number
}
const inFlight = new Map<string, InFlightEntry>()

// Keys currently running a background SWR revalidation, so a second stale
// hit for the same key while one is already in flight doesn't fire another.
// Maps key -> layerId so `invalidateLayer` can find and tombstone matching
// in-flight revalidations without a second lookup structure.
const revalidating = new Map<string, string>()
// Outstanding revalidation promises, exposed via `_pendingRevalidations` so
// tests can await determinism instead of racing background work.
const pendingRevalidations = new Set<Promise<void>>()

// Bumped per key by `invalidateLayer`. A fetch or revalidation already in
// flight when a layer is invalidated captures the generation it started
// with and checks it again right before writing back — if it's moved on,
// the invalidation happened mid-flight and the write-back is dropped so a
// forced refresh can't be silently undone by a late-arriving response.
const keyGeneration = new Map<string, number>()
function currentGeneration(key: string): number {
  return keyGeneration.get(key) ?? 0
}
function bumpGeneration(key: string): void {
  keyGeneration.set(key, currentGeneration(key) + 1)
}

export function resetForTests(): void {
  // Abort every in-flight fetch before dropping the map: without this, an
  // unsettled fetch from a prior test can still resolve later and write
  // into the *next* test's fresh mem/metrics via persistFetched.
  for (const entry of inFlight.values()) {
    entry.controller.abort()
  }
  inFlight.clear()

  // Close the IDB connection this generation of state was using rather than
  // just dropping the reference — otherwise the connection leaks and (e.g.)
  // a later `indexedDB.deleteDatabase()` call blocks forever behind it.
  const closingDb = dbPromise
  dbPromise = null
  void closingDb?.then((db) => db?.close())

  metrics = freshMetrics()
  mem.clear()
  memBytes = 0
  revalidating.clear()
  pendingRevalidations.clear()
  keyGeneration.clear()
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
    if (entry.abortedJoined >= entry.totalJoined) {
      entry.controller.abort()
      // Remove the doomed entry from `inFlight` right now, synchronously —
      // not when the rejection eventually propagates through networkPromise's
      // `.finally` (at least a macrotask later for a real fetch). Otherwise
      // a caller that calls startOrJoinFetch in that window would join this
      // entry and get a spurious AbortError despite never aborting itself.
      if (inFlight.get(entry.key) === entry) inFlight.delete(entry.key)
    }
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
  // Defensive bypass: a doomed entry should already have been swept out of
  // `inFlight` synchronously by `onAbort` (see joinCaller), but if one is
  // ever found here with its controller already aborted, treat it as if it
  // weren't there rather than joining a fetch that's already dead.
  if (entry?.controller.signal.aborted) entry = undefined
  if (entry) {
    metrics.dedupedRequests++
  } else {
    const controller = new AbortController()
    const gen = currentGeneration(key)
    const networkPromise = doFetch(url, null, store, controller.signal)
      .then(async (raw) => {
        // A miss-path fetch never sends If-None-Match, so it can only ever
        // come back 200 or 204 here (304 requires a prior etag). Skip the
        // write-back if the key was invalidated mid-flight (invalidateLayer
        // bumps the generation) — a forced refresh shouldn't be silently
        // undone by a response that was already on the wire.
        if (currentGeneration(key) === gen) {
          await persistFetched(store, key, layerId, raw)
        }
        if (raw.status === 200) metrics.networkBytes += raw.size
        return raw
      })
      .finally(() => {
        inFlight.delete(key)
      })
    // Every joiner attaches its own handler via joinCaller below, but guard
    // against an unhandled rejection in the window before any of them do.
    networkPromise.catch(() => {})
    entry = { key, layerId, controller, networkPromise, totalJoined: 0, abortedJoined: 0 }
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
  revalidating.set(key, layerId)

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
  const gen = currentGeneration(key)
  try {
    const raw = await doFetch(url, entry.etag, store)
    // The key may have been invalidated (forced refresh) while this
    // revalidation was on the wire — don't let a late response silently
    // undo that by writing back over the (already-cleared) entry.
    if (currentGeneration(key) !== gen) return
    if (raw.status === 304 || raw.status === 204) {
      // A 204 during revalidation is treated the same as a 304: refresh
      // metadata without discarding the cached value. The tile route only
      // ever answers a key that has a cached (non-empty) value with 304,
      // never a bare 204, but this is a general-purpose module other
      // callers will point at other URLs, so handle it rather than drop it.
      metrics.revalidated304++
      const updated: StoredEntry = { ...entry, storedAt: Date.now(), etag: raw.etag ?? entry.etag }
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

    // Fire-and-forget: a hit must return immediately, not block on an IDB
    // round-trip (which can mean re-serializing a multi-MB ArrayBuffer) just
    // to throttle-update lastAccess. bumpLastAccess can't actually reject
    // (idb.ts and openGeoDB swallow their own errors), but `.catch` is kept
    // as a defensive backstop against an unhandled rejection regardless.
    void bumpLastAccess(store, key, hit.entry).catch(() => {})
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
      bumpGeneration(key)
    }
  }
  // A fetch or revalidation already in flight for this layer must not be
  // able to silently undo the invalidation once it lands: abort the ones we
  // can (in-flight network fetches), and bump the generation for every
  // matching key so any write-back still in flight — including a
  // revalidation, which isn't cancellable mid-request — gets skipped even
  // if it completes after this call returns (a forced-refresh case: the key
  // itself doesn't change, so nothing else would invalidate it).
  for (const [key, entry] of inFlight) {
    if (entry.layerId !== layerId) continue
    bumpGeneration(key)
    entry.controller.abort()
  }
  for (const [key, revalidatingLayerId] of revalidating) {
    if (revalidatingLayerId === layerId) bumpGeneration(key)
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
