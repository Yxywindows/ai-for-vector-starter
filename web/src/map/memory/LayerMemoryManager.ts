export interface LayerUsage {
  layerId: string
  bytes: number
  lastUsed: number
  pinned: boolean
}

interface Entry {
  bytes: number
  lastUsed: number
  pinned: boolean
  onEvict: () => void
}

export interface LayerMemoryManagerOptions {
  /** Default 128 MiB — roughly what a tab can hold before scrolling gets janky. */
  budgetBytes?: number
  clock?: () => number
}

const DEFAULT_BUDGET = 128 * 1024 * 1024

/**
 * Memory layer 3 of 3: the browser.
 *
 * Every tile and every feature payload is weighed on arrival and charged to
 * the layer that asked for it. When the total crosses the budget, the least
 * recently used layer's cached data is dropped — `onEvict` clears the OL
 * source, so the bytes are actually released rather than merely uncounted.
 *
 * Two things are never evicted: a pinned layer (the one being edited or
 * inspected) and the most recently touched layer when it alone exceeds the
 * whole budget. Without the second rule a single layer larger than the whole
 * budget would be cleared and immediately refetched, forever.
 */
export class LayerMemoryManager {
  private readonly entries = new Map<string, Entry>()
  private readonly clock: () => number
  readonly budgetBytes: number

  constructor(options: LayerMemoryManagerOptions = {}) {
    this.budgetBytes = options.budgetBytes ?? DEFAULT_BUDGET
    this.clock = options.clock ?? (() => performance.now())
  }

  register(layerId: string, onEvict: () => void): void {
    const existing = this.entries.get(layerId)
    this.entries.set(layerId, {
      bytes: existing?.bytes ?? 0,
      lastUsed: existing?.lastUsed ?? this.clock(),
      pinned: existing?.pinned ?? false,
      onEvict,
    })
  }

  unregister(layerId: string): void {
    this.entries.delete(layerId)
  }

  record(layerId: string, bytes: number): void {
    const entry = this.entries.get(layerId)
    if (!entry) return
    entry.bytes += bytes
    entry.lastUsed = this.clock()
  }

  reset(layerId: string): void {
    const entry = this.entries.get(layerId)
    if (entry) entry.bytes = 0
  }

  touch(layerId: string): void {
    const entry = this.entries.get(layerId)
    if (entry) entry.lastUsed = this.clock()
  }

  setPinned(layerId: string, pinned: boolean): void {
    const entry = this.entries.get(layerId)
    if (entry) entry.pinned = pinned
  }

  get totalBytes(): number {
    let total = 0
    for (const entry of this.entries.values()) total += entry.bytes
    return total
  }

  usage(): LayerUsage[] {
    return [...this.entries.entries()]
      .map(([layerId, entry]) => ({
        layerId,
        bytes: entry.bytes,
        lastUsed: entry.lastUsed,
        pinned: entry.pinned,
      }))
      .sort((a, b) => b.bytes - a.bytes)
  }

  /**
   * Release every layer's cached data unconditionally — leaving the map
   * workspace must return the memory it borrowed (IA acceptance §9.4).
   * Pinning is ignored: there is no "in use" after the map unmounts.
   */
  clearAll(): string[] {
    const cleared: string[] = []
    for (const [layerId, entry] of this.entries) {
      if (entry.bytes > 0) cleared.push(layerId)
      entry.bytes = 0
      entry.onEvict()
    }
    return cleared
  }

  /** Evict LRU-first until under budget. Returns the ids that were evicted. */
  enforce(): string[] {
    const evicted: string[] = []
    if (this.totalBytes <= this.budgetBytes) return evicted

    const newest = [...this.entries.entries()].reduce<string | null>(
      (best, [layerId, entry]) =>
        best === null || entry.lastUsed > (this.entries.get(best)?.lastUsed ?? -Infinity)
          ? layerId
          : best,
      null,
    )
    // The thrash guard: only shield the newest layer when evicting it would
    // just trigger an immediate refetch of something too big to ever fit.
    const protectNewest =
      newest !== null && (this.entries.get(newest)?.bytes ?? 0) > this.budgetBytes

    const candidates = [...this.entries.entries()]
      .filter(
        ([layerId, entry]) =>
          !entry.pinned && (!protectNewest || layerId !== newest) && entry.bytes > 0,
      )
      .sort((a, b) => a[1].lastUsed - b[1].lastUsed)

    for (const [layerId, entry] of candidates) {
      if (this.totalBytes <= this.budgetBytes) break
      entry.bytes = 0
      entry.onEvict()
      evicted.push(layerId)
    }
    return evicted
  }
}
