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
}

export interface SharedReadCacheOptions<K, V> {
  /**
   * Performs the read. It is handed the *shared* signal, which fires only once
   * every caller waiting on this key has aborted — never one caller's own.
   */
  fill: (key: K, signal: AbortSignal) => Promise<V>

  /**
   * Budget, in whatever unit {@link sizeOf} returns. Settable later: lowering
   * it evicts immediately rather than waiting for the next read, which is what
   * a consumer shedding memory under pressure needs.
   */
  maxSize: number

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
 */
export class SharedReadCache<K, V> {
  private entries = new Map<string, Entry<V>>()
  private total = 0
  private limit: number
  private fill: (key: K, signal: AbortSignal) => Promise<V>
  private sizeOf: (value: V) => number
  private toCacheKey: (key: K) => string

  constructor({
    fill,
    maxSize,
    sizeOf = () => 1,
    cacheKey = (key: K) => String(key),
  }: SharedReadCacheOptions<K, V>) {
    this.fill = fill
    this.limit = maxSize
    this.sizeOf = sizeOf
    this.toCacheKey = cacheKey
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

  async get(key: K, signal?: AbortSignal) {
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
      // A read every caller has abandoned is on its way out but may not have
      // noticed yet. Start a fresh one rather than join one already doomed —
      // joining it means inheriting a cancellation nothing to do with us.
      if (!entry.settled && entry.controller.signal.aborted) {
        this.delete(key)
        entry = undefined
      }
    }
    entry ??= this.start(cacheKey, key)
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

  has(key: K) {
    return this.entries.has(this.toCacheKey(key))
  }

  delete(key: K) {
    this.deleteKey(this.toCacheKey(key))
  }

  clear() {
    this.entries.clear()
    this.total = 0
  }

  // The read runs under the entry's own controller rather than any one caller's
  // signal, because the read is shared: it must survive until every caller
  // waiting on it has given up. join() is what registers them.
  private start(cacheKey: string, key: K) {
    const controller = new AbortController()
    const entry: Entry<V> = {
      promise: this.fill(key, controller.signal),
      signals: new Set(),
      pinned: false,
      controller,
      dispose: new AbortController(),
      settled: false,
      size: 0,
    }
    this.entries.set(cacheKey, entry)
    const settle = () => {
      entry.settled = true
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
          this.evict()
        }
      },
      () => {
        settle()
        // a failed read caches nothing, so the next caller starts over rather
        // than inheriting the failure
        if (this.entries.get(cacheKey) === entry) {
          this.entries.delete(cacheKey)
        }
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
  private evict() {
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
