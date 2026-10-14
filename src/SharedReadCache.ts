import { abortReason, throwIfAborted } from './throwIfAborted.ts'

import type { Budget, BudgetMember, BudgetMembership } from './SharedBudget.ts'

/** Present only while the read is in flight. */
interface PendingRead {
  /** each waiting caller's signal, with the abort listener put on it */
  signals: Map<AbortSignal, () => void>
  /** set once a caller that cannot abort joins */
  pinned: boolean
  /** aborts once every caller has given up; the read runs under its signal */
  controller: AbortController
}

interface Entry<V> {
  promise: Promise<V>
  pending?: PendingRead
  /** 0 until the read settles */
  size: number
  /** `Date.now()` at the last lookup or at settling, for the idle sweep */
  lastTouched: number
  /** the budget's stamp at the last lookup, for cross-cache LRU order */
  seq: number
}

/** false for no signal, or a duck-typed `{ aborted }` with no listeners */
function isSubscribable(signal?: AbortSignal): signal is AbortSignal {
  return typeof signal?.addEventListener === 'function'
}

export interface SharedReadCacheOptions<K, V> {
  /**
   * Performs the read under the *shared* signal, which aborts only once every
   * caller waiting on the key has aborted. Pass it here or to each
   * {@link SharedReadCache.get}.
   */
  fill?: (key: K, signal: AbortSignal) => Promise<V>

  /**
   * Budget, in the unit {@link sizeOf} returns. Defaults to `Infinity`. Bounds
   * retained memory, not request size: the cache never refuses a value, never
   * evicts a read in flight, and keeps its last settled entry. Setting it later
   * evicts immediately.
   */
  maxSize?: number

  /** Weighs a settled value against `maxSize`. Defaults to 1, an entry count. */
  sizeOf?: (value: V) => number

  /** Maps a key to its cache key. Defaults to `String(key)`. */
  cacheKey?: (key: K) => string

  /**
   * A budget shared with other caches, evicted globally least-recently-used
   * across all of them. `maxSize` still bounds this cache on its own.
   */
  budget?: Budget

  /**
   * Drop a settled entry once nothing has read it for this many milliseconds.
   * Defaults to no idle eviction. The clock runs from the last read, or from
   * the read settling.
   */
  idleTimeoutMs?: number
}

/**
 * One read per key, shared by every caller that asks for it while it is in
 * flight, with a bounded cache of the results.
 *
 * - The read is cancelled only once every waiting caller has aborted. A caller
 *   with no signal, or one with no `addEventListener`, pins it.
 * - A caller's abort rejects that caller alone, at once.
 * - A rejection is dropped rather than cached.
 *
 * See docs/dataflow.md and docs/memory.md.
 */
export class SharedReadCache<K, V> implements BudgetMember {
  private entries = new Map<string, Entry<V>>()
  private total = 0
  // maintained rather than counted, because evict() needs it on every settle
  private settledCount = 0
  private limit: number
  private shared?: { budget: Budget; membership: BudgetMembership }
  private fill?: (key: K, signal: AbortSignal) => Promise<V>
  private sizeOf: (value: V) => number
  private toCacheKey: (key: K) => string
  private idleTimeoutMs?: number
  private sweepTimer?: ReturnType<typeof setInterval>

  constructor({
    fill,
    maxSize = Infinity,
    sizeOf = () => 1,
    cacheKey = (key: K) => String(key),
    idleTimeoutMs = 0,
    budget,
  }: SharedReadCacheOptions<K, V> = {}) {
    this.fill = fill
    this.limit = maxSize
    this.shared = budget && { budget, membership: budget.register(this) }
    this.sizeOf = sizeOf
    this.toCacheKey = cacheKey
    this.idleTimeoutMs =
      idleTimeoutMs > 0 && Number.isFinite(idleTimeoutMs)
        ? idleTimeoutMs
        : undefined
  }

  /** Number of entries held, including reads still in flight. */
  get size() {
    return this.entries.size
  }

  /** Sum of {@link SharedReadCacheOptions.sizeOf} over the settled entries. */
  get totalSize() {
    return this.total
  }

  get maxSize() {
    return this.limit
  }

  /** Lowering it evicts immediately. */
  set maxSize(maxSize: number) {
    this.limit = maxSize
    this.evict()
  }

  /** How many caller signals the entry under `key` holds. Exposed for tests. */
  waiterCount(key: K) {
    return this.entries.get(this.toCacheKey(key))?.pending?.signals.size ?? 0
  }

  async get(
    key: K,
    signal?: AbortSignal,
    fill?: (signal: AbortSignal) => Promise<V>,
  ) {
    throwIfAborted(signal)

    const cacheKey = this.toCacheKey(key)
    let entry = this.entries.get(cacheKey)
    if (entry && this.isDoomed(entry)) {
      this.release(cacheKey)
      entry = undefined
    }
    if (entry) {
      this.touch(cacheKey, entry)
    } else {
      entry = this.start(cacheKey, key, fill)
    }
    if (entry.pending) {
      this.join(entry.pending, signal)
    }

    try {
      return await this.settleFor(entry, signal)
    } finally {
      // the caller's own abort wins over the shared outcome, a value included
      throwIfAborted(signal)
    }
  }

  /** The shared read, raced against this caller's own abort. */
  private settleFor(entry: Entry<V>, signal?: AbortSignal) {
    if (!entry.pending || !isSubscribable(signal)) {
      return entry.promise
    }
    let reject: (reason: unknown) => void
    const aborted = new Promise<never>((_resolve, rejectAborted) => {
      reject = rejectAborted
    })
    const onAbort = () => {
      reject(abortReason(signal))
    }
    // removed by reference: Node holds a `{ signal }` option's removal hook
    // weakly and loses it after a GC when one target has two
    signal.addEventListener('abort', onAbort, { once: true })
    return Promise.race([entry.promise, aborted]).finally(() => {
      signal.removeEventListener('abort', onAbort)
    })
  }

  /**
   * The promise cached under `key`, or `undefined`. Marks the entry
   * most-recently-used, but does not register the caller as a waiter.
   */
  getIfCached(key: K) {
    const cacheKey = this.toCacheKey(key)
    const entry = this.entries.get(cacheKey)
    if (!entry) {
      return undefined
    }
    if (this.isDoomed(entry)) {
      this.release(cacheKey)
      return undefined
    }
    this.touch(cacheKey, entry)
    return entry.promise
  }

  /** Whether {@link get} would hit, without touching the LRU order. */
  has(key: K) {
    const entry = this.entries.get(this.toCacheKey(key))
    return entry !== undefined && !this.isDoomed(entry)
  }

  delete(key: K) {
    this.release(this.toCacheKey(key))
  }

  clear() {
    this.entries.clear()
    this.shared?.budget.charge(this.shared.membership, -this.total)
    this.total = 0
    this.settledCount = 0
    this.stopSweep()
  }

  // lruSpare() reads map order and reports seq, so the two move together
  private touch(cacheKey: string, entry: Entry<V>) {
    this.entries.delete(cacheKey)
    this.entries.set(cacheKey, entry)
    entry.lastTouched = Date.now()
    entry.seq = this.stamp()
  }

  private stamp() {
    return this.shared?.budget.nextSeq() ?? 0
  }

  /** In flight, but every caller waiting on it has already given up. */
  private isDoomed(entry: Entry<V>) {
    return entry.pending?.controller.signal.aborted === true
  }

  /**
   * Evict entries nothing has read for
   * {@link SharedReadCacheOptions.idleTimeoutMs}. A no-op without one.
   */
  sweepIdle() {
    const timeout = this.idleTimeoutMs
    if (timeout === undefined) {
      return
    }
    const cutoff = Date.now() - timeout
    for (const [cacheKey, entry] of this.entries) {
      if (!entry.pending && entry.lastTouched <= cutoff) {
        this.release(cacheKey)
      }
    }
    // not `entries.size`: a read that never settles must not keep the timer
    if (this.settledCount === 0) {
      this.stopSweep()
    }
  }

  // The timer holds the cache weakly, so a dropped cache is collected without
  // a dispose() call.
  private startSweep() {
    const timeout = this.idleTimeoutMs
    if (timeout === undefined || this.sweepTimer !== undefined) {
      return
    }
    // a quarter of the timeout, at least a second, and at most what a timer
    // can hold
    const interval = Math.min(
      2 ** 31 - 1,
      Math.max(1000, Math.floor(timeout / 4)),
    )
    const ref = new WeakRef(this)
    const timer = setInterval(() => {
      const cache = ref.deref()
      if (cache) {
        cache.sweepIdle()
      } else {
        clearInterval(timer)
      }
    }, interval)
    this.sweepTimer = timer
    ;(timer as { unref?: () => void }).unref?.()
  }

  private stopSweep() {
    if (this.sweepTimer !== undefined) {
      clearInterval(this.sweepTimer)
      this.sweepTimer = undefined
    }
  }

  private start(
    cacheKey: string,
    key: K,
    fill?: (signal: AbortSignal) => Promise<V>,
  ) {
    const run = fill ?? (this.fill && ((s: AbortSignal) => this.fill!(key, s)))
    if (!run) {
      throw new Error(
        'SharedReadCache needs a fill, either on the cache or on the get() call',
      )
    }
    const pending: PendingRead = {
      signals: new Map(),
      pinned: false,
      controller: new AbortController(),
    }
    const entry: Entry<V> = {
      // Promise.resolve so an untyped fill returning a bare value still works
      promise: Promise.resolve(run(pending.controller.signal)),
      pending,
      size: 0,
      lastTouched: Date.now(),
      seq: this.stamp(),
    }
    this.entries.set(cacheKey, entry)
    const isCurrent = () => this.entries.get(cacheKey) === entry
    const settle = () => {
      for (const [signal, onAbort] of pending.signals) {
        signal.removeEventListener('abort', onAbort)
      }
      entry.pending = undefined
    }
    // `.then(f, g)` rather than `.finally(f)`, which would leave an unhandled
    // rejection
    void entry.promise.then(
      value => {
        // weighed while still pending, so a sizeOf that deletes or clears
        // removes an uncounted entry
        const size = isCurrent() ? this.weigh(value) : undefined
        const current = isCurrent()
        settle()
        if (current) {
          if (size === undefined) {
            this.entries.delete(cacheKey)
          } else {
            // not touch(): eviction follows the order reads were asked for,
            // not the order they landed in
            entry.lastTouched = Date.now()
            entry.size = size
            this.settledCount++
            this.total += size
            this.shared?.budget.charge(this.shared.membership, size)
            this.startSweep()
          }
        }
        this.evict()
        this.shared?.budget.evict()
      },
      () => {
        // released before settle(), so release() sees an uncounted read
        if (isCurrent()) {
          this.release(cacheKey)
        }
        settle()
      },
    )
    return entry
  }

  /**
   * `sizeOf`, or `undefined` if it throws or returns anything but a finite
   * non-negative number, which drops the entry. A `NaN` in `total` would make
   * every later settle evict down to one entry.
   */
  private weigh(value: V) {
    try {
      const size = this.sizeOf(value)
      return Number.isFinite(size) && size >= 0 ? size : undefined
    } catch {
      return undefined
    }
  }

  private join(pending: PendingRead, signal?: AbortSignal) {
    if (!isSubscribable(signal)) {
      pending.pinned = true
    } else if (!signal.aborted && !pending.signals.has(signal)) {
      // An abort listener never fires on a signal that aborted before it was
      // added, so such a caller would pin the read. get() already rejects it.
      const onAbort = () => {
        pending.signals.delete(signal)
        if (!pending.pinned && pending.signals.size === 0) {
          pending.controller.abort(signal.reason)
        }
      }
      pending.signals.set(signal, onAbort)
      signal.addEventListener('abort', onAbort, { once: true })
    }
  }

  /** @internal also how a budget evicts on this cache's behalf */
  release(cacheKey: string) {
    const entry = this.entries.get(cacheKey)
    if (entry) {
      this.entries.delete(cacheKey)
      if (!entry.pending) {
        this.settledCount--
      }
      this.total -= entry.size
      this.shared?.budget.charge(this.shared.membership, -entry.size)
    }
  }

  /**
   * @internal The least-recently-used settled entry, or `undefined` if there
   * is none, or only one and `offerLast` is not set.
   */
  lruSpare(offerLast = false) {
    if (this.settledCount <= (offerLast ? 0 : 1)) {
      return undefined
    }
    for (const [cacheKey, entry] of this.entries) {
      if (!entry.pending) {
        return { cacheKey, seq: entry.seq, last: this.settledCount === 1 }
      }
    }
    return undefined
  }

  /**
   * Evict least-recently-used settled entries down to `maxSize`, skipping
   * reads in flight and keeping the last settled entry.
   */
  private evict() {
    if (this.total <= this.limit) {
      return
    }
    for (const [cacheKey, entry] of this.entries) {
      if (this.total <= this.limit || this.settledCount <= 1) {
        break
      }
      if (!entry.pending) {
        this.release(cacheKey)
      }
    }
  }
}
