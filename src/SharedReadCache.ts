import { throwIfAborted } from './throwIfAborted.ts'

interface Entry<V> {
  promise: Promise<V>
  /**
   * Signals of the callers still waiting on this read. The read is cancelled
   * only once every one of them has given up — see {@link SharedReadCache.join}.
   */
  signals: Set<AbortSignal>
  /** true once a caller joins without a signal, which pins the read */
  pinned: boolean
  /** aborts when every caller has given up; what the read actually runs under */
  controller: AbortController
  /** aborted to take this read's listeners back off its callers' signals */
  dispose: AbortController
  settled: boolean
  /** 0 until the read settles and the value can be weighed */
  size: number
  /** touched by the batch in flight; only meaningful under the batch policy */
  touched: boolean
  /**
   * `Date.now()` at the last {@link SharedReadCache.get} or
   * {@link SharedReadCache.getIfCached} that resolved to this entry.
   * Only meaningful when {@link SharedReadCacheOptions.idleTimeoutMs} is set.
   */
  lastTouched: number
}

export interface SharedReadCacheOptions<K, V> {
  /**
   * Performs the read. It is handed the *shared* signal, which fires only once
   * every caller waiting on this key has aborted — never one caller's own.
   *
   * Optional, because a caller whose read differs per key — a closure over the
   * thing being read, rather than a function of the key — can pass it to
   * {@link SharedReadCache.get} instead. One of the two must be present.
   */
  fill?: (key: K, signal: AbortSignal) => Promise<V>

  /**
   * Budget, in whatever unit {@link sizeOf} returns. Defaults to `Infinity`:
   * this package does not prescribe a limit, because what a sensible one is
   * depends entirely on what is being cached.
   *
   * Note what a budget does and does not do. It bounds *retained* memory, not
   * request size: a value larger than the whole budget is still kept, reads in
   * flight are never evicted, and eviction only ever discards a value already
   * returned once. So nothing is refused for being too large, and the worst a
   * budget can cost is a re-read.
   *
   * Unbounded is therefore the permissive default, not the safe one. A cache
   * with no budget grows for the life of the object — @gmod/tabix measured 2GB
   * RSS panning a dense VCF before it bounded this. Pass one if the values are
   * large or the object is long-lived.
   *
   * Settable later: lowering it evicts immediately rather than waiting for the
   * next read, which is what a consumer shedding memory under pressure needs.
   */
  maxSize?: number

  /**
   * Weighs a settled value against `maxSize`. Defaults to 1, making the budget
   * an entry count.
   *
   * This is the parameter the whole package exists for. Every hand-rolled copy
   * of this cache across the gmod repos was identical except here: @gmod/bam
   * and @gmod/tabix weigh decompressed bytes, @gmod/bbi weighs entries, and
   * @gmod/cram weighs decoded records. An entry cannot be weighed until its
   * read settles, so a cache that does this has to own its entries — which is
   * exactly why those four could not share a plain-LRU-backed package and each
   * wrote their own.
   */
  sizeOf?: (value: V) => number

  /** Maps a key to its cache key. Defaults to `String(key)`. */
  cacheKey?: (key: K) => string

  /**
   * When to evict. Defaults to `'lru'`.
   *
   * `'lru'` evicts as each read settles, so the budget is a hard ceiling.
   *
   * `'batch'` waits until no reads are in flight and then spares everything
   * that batch touched. Use it when a single request starts many reads at once
   * and holds all of their values until it returns: evicting one mid-request
   * frees nothing, because the caller is still holding it, but it does
   * guarantee the next identical request re-reads it. @gmod/cram measured 117ms
   * against 12ms on a repeated wide range for exactly this.
   *
   * The trade is real, which is why it is not the default: a batch that touches
   * more than the whole budget leaves the cache over it until the next batch
   * lands. Do not use it where the budget is a memory guarantee.
   */
  evictionPolicy?: 'lru' | 'batch'
  /**
   * Drop an entry once nothing has asked for it for this many milliseconds.
   * Defaults to no idle eviction.
   *
   * This is the only reclamation that happens while a consumer sits still.
   * {@link maxSize} is enforced when a read settles, so an idle cache stays at
   * whatever it reached and never gives it back — fine for a short-lived
   * object, expensive for one that lives as long as its UI does. A genome
   * browser parked on a region holds its whole last view indefinitely, times
   * every open track.
   *
   * The two compose and answer different questions. `maxSize` is the ceiling
   * under load, and wants to be generous: set below one request's working set
   * it does not cache less, it caches *nothing*, evicting each value before the
   * next request can reuse it while still retaining the ones in flight.
   * `idleTimeoutMs` is what makes a generous ceiling affordable, by making it a
   * peak rather than a resting level.
   *
   * Measured from the last **read** of an entry, not from when it was filled:
   * something fetched once and used every second is not idle, and an absolute
   * expiry would throw it away mid-use for no reason.
   *
   * Reads still in flight are never swept, on the same grounds as eviction —
   * they have no weight to reclaim and dropping one would lose the
   * de-duplication every caller joined to it is relying on.
   */
  idleTimeoutMs?: number
}

/**
 * One read per key, shared by every caller that asks for it while it is in
 * flight, with a bounded cache of the results.
 *
 * ## Why not a memoized promise
 *
 * Memoizing a bare promise built from the *first* caller's signal makes that
 * caller's abort reject everyone else awaiting it. In a genome browser, panning
 * away from one block then fails its still-wanted siblings. Here the read runs
 * under a controller of its own, and a caller's abort is reported to that
 * caller alone.
 *
 * ## The cancellation rule
 *
 * A read is cancelled only once **every** caller waiting on it has given up. A
 * caller with no signal cannot give up, so it pins the read — the honest
 * reading of a caller that never asked to be cancellable, and the reason one
 * signal-free consumer makes a read uncancellable for everyone joined to it.
 *
 * A rejection is dropped rather than cached, so one transient failure does not
 * poison the key for the life of the cache.
 *
 * ## On "LRU"
 *
 * With no {@link SharedReadCacheOptions.maxSize} nothing is ever evicted, so
 * this is a shared-read memo and not an LRU at all — least-recently-used is an
 * *eviction order*, and there is no eviction to order. Recency is still tracked
 * while unbounded, cheaply, so that imposing a budget later evicts the right
 * entries rather than the oldest-inserted ones.
 */
export class SharedReadCache<K, V> {
  private entries = new Map<string, Entry<V>>()
  private total = 0
  private limit: number
  private fill?: (key: K, signal: AbortSignal) => Promise<V>
  private sizeOf: (value: V) => number
  private toCacheKey: (key: K) => string
  private evictionPolicy: 'lru' | 'batch'
  /** reads still in flight, so the batch policy knows when the batch is done */
  private pending = 0
  private idleTimeoutMs?: number
  private sweepTimer?: ReturnType<typeof setInterval>

  constructor({
    fill,
    maxSize = Infinity,
    sizeOf = () => 1,
    cacheKey = (key: K) => String(key),
    evictionPolicy = 'lru',
    idleTimeoutMs,
  }: SharedReadCacheOptions<K, V>) {
    this.fill = fill
    this.evictionPolicy = evictionPolicy
    this.limit = maxSize
    this.sizeOf = sizeOf
    this.toCacheKey = cacheKey
    this.idleTimeoutMs =
      idleTimeoutMs !== undefined && idleTimeoutMs > 0
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

  /**
   * Accessor rather than a plain field so lowering the budget frees memory now.
   * As a field it did nothing until the next read happened to run the eviction
   * loop, which on an idle consumer is never.
   */
  set maxSize(maxSize: number) {
    this.limit = maxSize
    this.evict()
  }

  /**
   * How many caller signals the entry under `key` is still holding. Exposed for
   * tests: an entry that has leaked a thousand stale signals answers every read
   * exactly like one that has not, so nothing else would notice.
   */
  waiterCount(key: K) {
    return this.entries.get(this.toCacheKey(key))?.signals.size ?? 0
  }

  async get(
    key: K,
    signal?: AbortSignal,
    fill?: (signal: AbortSignal) => Promise<V>,
  ) {
    // Before anything else, including the cache hit. A caller can reach here
    // with a signal that has already fired — the abort lands while some earlier
    // await is still in flight and nothing in between looks at it. Such a
    // caller must not start a read it has no interest in, and must not be
    // registered as a waiter on someone else's: see join().
    throwIfAborted(signal)

    const cacheKey = this.toCacheKey(key)
    let entry = this.entries.get(cacheKey)
    if (entry) {
      // re-insert so Map iteration order stays least-recently-used first
      this.entries.delete(cacheKey)
      this.entries.set(cacheKey, entry)
      entry.touched = true
      entry.lastTouched = Date.now()
      // A read every caller has abandoned is on its way out but may not have
      // noticed yet. Start a fresh one rather than join one already doomed —
      // joining it means inheriting a cancellation nothing to do with us.
      if (!entry.settled && entry.controller.signal.aborted) {
        this.delete(key)
        entry = undefined
      }
    }
    entry ??= this.start(cacheKey, key, fill)
    // Only a read still running has anything to cancel. Joining a settled one
    // would add this caller to a set nothing will ever take it out of, since
    // the entry drops its abort listeners when it settles.
    if (!entry.settled) {
      this.join(entry, signal)
    }

    try {
      const value = await entry.promise
      // the read finished, but this caller gave up while waiting for it
      throwIfAborted(signal)
      return value
    } catch (e) {
      // Prefer this caller's own cancellation to whatever the shared read
      // reported. If we asked to stop, that is the answer we want — and when
      // the read itself was cancelled it is because we, and everyone else,
      // asked it to.
      throwIfAborted(signal)
      throw e
    }
  }

  /**
   * The promise cached under `key`, or `undefined` if there is none.
   *
   * Marks the entry most-recently-used, exactly as {@link get} does: this is a
   * lookup that happens not to start a read, not an inspection. Use
   * {@link has} if you need to ask without touching the LRU order.
   *
   * The promise is the shared one, so awaiting it does not register the caller
   * as a waiter and its rejection is not re-reported per caller. Callers that
   * want either should use {@link get}.
   */
  getIfCached(key: K) {
    const cacheKey = this.toCacheKey(key)
    const entry = this.entries.get(cacheKey)
    if (!entry) {
      return undefined
    }
    this.entries.delete(cacheKey)
    this.entries.set(cacheKey, entry)
    entry.touched = true
    entry.lastTouched = Date.now()
    return entry.promise
  }

  has(key: K) {
    return this.entries.has(this.toCacheKey(key))
  }

  delete(key: K) {
    this.deleteKey(this.toCacheKey(key))
  }

  clear() {
    this.entries.clear()
    this.total = 0
    this.stopSweep()
  }

  /**
   * Evict entries nothing has read for {@link SharedReadCacheOptions.idleTimeoutMs}.
   *
   * Exposed so a consumer can reclaim on its own schedule — a browser tab going
   * hidden, say — rather than only on the interval. A no-op when no idle
   * timeout is configured.
   */
  sweepIdle() {
    const timeout = this.idleTimeoutMs
    if (timeout === undefined) {
      return
    }
    const cutoff = Date.now() - timeout
    for (const [cacheKey, entry] of this.entries) {
      // in-flight entries are skipped for the same reason evict() skips them:
      // no weight to reclaim, and dropping one loses the de-duplication its
      // waiters joined for
      if (entry.settled && entry.lastTouched <= cutoff) {
        this.deleteKey(cacheKey)
      }
    }
    if (this.entries.size === 0) {
      this.stopSweep()
    }
  }

  // The sweep runs on an interval because it is the one form of reclamation
  // that has to happen when nothing is calling in — a lazy check on get() would
  // never fire on precisely the idle consumer this exists for.
  //
  // It costs nothing when the cache is empty: the timer starts with the first
  // entry and the sweep that empties the cache stops it again. That is also
  // what makes a dispose() method unnecessary. A consumer that drops the cache
  // without clearing it leaves one timer alive for at most a timeout plus a
  // sweep interval, after which the sweep empties the entries and stops itself,
  // and the whole thing becomes garbage.
  private startSweep() {
    const timeout = this.idleTimeoutMs
    if (timeout === undefined || this.sweepTimer !== undefined) {
      return
    }
    // a fraction of the timeout, so the lag between an entry going idle and
    // being reclaimed is bounded by ~1.25x it rather than 2x
    const interval = Math.max(1000, Math.floor(timeout / 4))
    this.sweepTimer = setInterval(() => {
      this.sweepIdle()
    }, interval)
    // Node holds the process open for a pending interval; a library timer must
    // never be the reason a script does not exit. Guarded because browsers and
    // workers return a number here, with no unref on it.
    const timer: unknown = this.sweepTimer
    if (
      typeof timer === 'object' &&
      timer !== null &&
      'unref' in timer &&
      typeof timer.unref === 'function'
    ) {
      timer.unref()
    }
  }

  private stopSweep() {
    if (this.sweepTimer !== undefined) {
      clearInterval(this.sweepTimer)
      this.sweepTimer = undefined
    }
  }

  // The read runs under the entry's own controller rather than any one caller's
  // signal, because the read is shared: it must survive until every caller
  // waiting on it has given up. join() is what registers them.
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
    const controller = new AbortController()
    const entry: Entry<V> = {
      promise: run(controller.signal),
      signals: new Set(),
      pinned: false,
      controller,
      dispose: new AbortController(),
      settled: false,
      size: 0,
      touched: true,
      lastTouched: Date.now(),
    }
    this.entries.set(cacheKey, entry)
    this.startSweep()
    this.pending++
    const settle = () => {
      entry.settled = true
      this.pending--
      // nothing reads these once the read has settled, and holding them would
      // pin each caller's AbortController behind this entry
      entry.dispose.abort()
      entry.signals.clear()
    }
    // `.then(f, g)` rather than `.finally(f)` so the handler's own promise never
    // carries an unhandled rejection.
    void entry.promise.then(
      value => {
        settle()
        // a later read may have replaced this key while this one was in
        // flight; charging its weight to that entry would double-count
        if (this.entries.get(cacheKey) === entry) {
          entry.size = this.sizeOf(value)
          this.total += entry.size
        }
        this.maybeEvict()
      },
      () => {
        settle()
        // a failed read caches nothing, so the next caller starts over rather
        // than inheriting the failure
        if (this.entries.get(cacheKey) === entry) {
          this.entries.delete(cacheKey)
        }
        this.maybeEvict()
      },
    )
    return entry
  }

  // Register a caller's interest, so the read survives until that caller has
  // given up too.
  private join(entry: Entry<V>, signal?: AbortSignal) {
    if (signal === undefined) {
      entry.pinned = true
    } else if (signal.aborted) {
      // A caller that has already given up is not a waiter, and must not be
      // counted as one: an `abort` listener never fires on a signal that
      // aborted before it was added, so nothing would ever take this signal
      // back out of the set. The count would never reach zero and the read
      // would be uncancellable for everyone joined to it, silently.
      //
      // get() rejects such a caller before it reaches here, with no `await` in
      // between, so this is unreachable today. It is here because this is the
      // bug that shipped in @gmod/abortable-promise-cache, and an invariant
      // that fails this quietly should not rest on a check twenty lines away.
      if (!entry.pinned && entry.signals.size === 0) {
        entry.controller.abort(signal.reason)
      }
    } else if (!entry.signals.has(signal)) {
      // guarded so one signal joining the same key twice does not add two
      // listeners
      entry.signals.add(signal)
      signal.addEventListener(
        'abort',
        () => {
          entry.signals.delete(signal)
          if (!entry.pinned && entry.signals.size === 0) {
            entry.controller.abort(signal.reason)
          }
        },
        // `once` covers the abort firing; `dispose` covers it never firing.
        // Without this a long-lived signal accumulates one listener per key it
        // ever touches, which is what @gmod/abortable-promise-cache did.
        { once: true, signal: entry.dispose.signal },
      )
    }
  }

  private deleteKey(cacheKey: string) {
    const entry = this.entries.get(cacheKey)
    if (entry) {
      this.entries.delete(cacheKey)
      this.total -= entry.size
    }
  }

  /**
   * Evict from the least-recently-used end.
   *
   * Reads still in flight are skipped: they are not results yet, they have no
   * weight to reclaim, and dropping one would lose the de-duplication every
   * caller joined to it is relying on.
   *
   * The last settled entry is kept whatever the budget. A single value larger
   * than the whole budget is still worth holding — the caller needs it for the
   * request in flight, so dropping it only buys an immediate re-read.
   */
  // Under the batch policy nothing is evicted until the whole batch has
  // settled: a request that starts many reads at once is still holding all of
  // their values, so evicting one frees nothing and only costs a re-read.
  private maybeEvict() {
    if (this.evictionPolicy === 'lru' || this.pending === 0) {
      this.evict()
    }
  }

  private evict() {
    if (this.limit === Infinity) {
      return
    }
    if (this.evictionPolicy === 'batch') {
      for (const [cacheKey, entry] of this.entries) {
        if (this.total <= this.limit) {
          break
        }
        if (!entry.touched && entry.settled) {
          this.deleteKey(cacheKey)
        }
      }
      for (const entry of this.entries.values()) {
        entry.touched = false
      }
      return
    }

    let settled = 0
    for (const entry of this.entries.values()) {
      if (entry.settled) {
        settled++
      }
    }
    for (const [cacheKey, entry] of this.entries) {
      if (this.total <= this.limit || settled <= 1) {
        break
      }
      if (entry.settled) {
        this.deleteKey(cacheKey)
        settled--
      }
    }
  }
}
