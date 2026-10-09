import { abortReason, throwIfAborted } from './throwIfAborted.ts'

import type { Budget, BudgetMember, BudgetMembership } from './SharedBudget.ts'

/** What exists only to cancel a read, so only while it is in flight. */
interface PendingRead {
  /**
   * The callers still waiting on this read, each with the listener the read put
   * on its signal. The read is cancelled only once every one of them has given
   * up — see {@link SharedReadCache.join}.
   */
  signals: Map<AbortSignal, () => void>
  /** true once a caller that cannot give up has joined, which pins the read */
  pinned: boolean
  /** aborts when every caller has given up; what the read actually runs under */
  controller: AbortController
}

interface Entry<V> {
  promise: Promise<V>
  /**
   * Dropped when the read settles, so `undefined` is what "settled" means and a
   * cached value carries none of the machinery that was there to cancel it.
   */
  pending?: PendingRead
  /** 0 until the read settles and the value can be weighed */
  size: number
  /**
   * `Date.now()` at the last {@link SharedReadCache.get} or
   * {@link SharedReadCache.getIfCached} that resolved to this entry, or at its
   * read settling if that is later. What the idle sweep measures from.
   */
  lastTouched: number
  /**
   * The budget's stamp at the last touch, for the cross-cache LRU order it
   * evicts by; 0 when there is no budget. See {@link Budget.nextSeq}.
   */
  seq: number
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
   * A budget shared with other caches, evicted globally least-recently-used
   * across all of them. Defaults to none.
   *
   * Composes with {@link maxSize} rather than replacing it: the per-cache
   * ceiling still applies, and a cache that passes only a budget is unbounded
   * on its own and bounded in aggregate — usually what you want, since the
   * point of sharing is to let one busy member use most of the total.
   *
   * Reach for it when the number of caches is a property of the workload
   * rather than of the code. A per-cache ceiling sized so that one cache never
   * thrashes is, by construction, not a bound on N of them; see
   * {@link SharedBudget} for what that measured.
   */
  budget?: Budget
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
   * Measured from the last **read** of an entry, or from its fill settling if
   * nothing has read it since: something fetched once and used every second is
   * not idle, and an absolute expiry would throw it away mid-use for no reason.
   * The clock never starts before the value exists, so however long a read
   * takes it still gets the full timeout to be reused in.
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
 * signal-free consumer makes a read uncancellable for everyone joined to it. A
 * duck-typed signal with no `addEventListener` pins it for the same reason —
 * nothing here can learn when such a caller gives up — and is still told about
 * its own cancellation once the read settles.
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
export class SharedReadCache<K, V> implements BudgetMember {
  private entries = new Map<string, Entry<V>>()
  private total = 0
  /**
   * How many of {@link entries} have settled. Maintained rather than counted,
   * because {@link evict} needs it on every settle and a cache sitting at its
   * ceiling is over the limit on every settle — so the O(entries) count it
   * replaces was the steady-state cost of having a budget at all. That count
   * measured 8.6us per read over 100 entries and 134us over 20,000; maintaining
   * it instead holds 7.4us and 14us across the same range.
   */
  private settledCount = 0
  private limit: number
  /** the budget this cache joined, and the handle it reports its weight by */
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
    // Defaulted, because a cache with no options at all is a real shape and a
    // common one: the memo, whose fill is a closure passed per get() call. Five
    // of these exist across @gmod/bam, @gmod/tabix and indexedfasta-js, and
    // every one of them was written `new SharedReadCache({})`.
  }: SharedReadCacheOptions<K, V> = {}) {
    this.fill = fill
    this.limit = maxSize
    this.shared = budget && { budget, membership: budget.register(this) }
    this.sizeOf = sizeOf
    this.toCacheKey = cacheKey
    // 0, a negative and Infinity all mean "no idle eviction", so the rest of
    // the class has one thing to check
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
    return this.entries.get(this.toCacheKey(key))?.pending?.signals.size ?? 0
  }

  async get(
    key: K,
    signal?: AbortSignal,
    fill?: (signal: AbortSignal) => Promise<V>,
  ) {
    // Before the cache hit too: a caller that has already given up must not
    // start a read, nor be registered as a waiter on someone else's.
    throwIfAborted(signal)

    const cacheKey = this.toCacheKey(key)
    let entry = this.entries.get(cacheKey)
    // A read every caller has abandoned is replaced rather than joined, since
    // joining it means inheriting a cancellation that is not this caller's.
    if (entry && this.isDoomed(entry)) {
      this.deleteKey(cacheKey)
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
      // This caller's own cancellation wins over whatever the shared read
      // reported, a value included: it gave up while waiting.
      throwIfAborted(signal)
    }
  }

  /**
   * The shared read, but a caller that gives up while it is still running is
   * released now rather than whenever that read lands. The read is shared, so
   * one caller aborting does not stop it, and awaiting `entry.promise` alone
   * left that caller pending until every other waiter was done — or forever,
   * against a fill that ignores its signal.
   *
   * Only for a read in flight and a signal that can be subscribed to. The rest
   * fall back to the {@link throwIfAborted} in {@link get}.
   */
  private settleFor(entry: Entry<V>, signal?: AbortSignal) {
    if (
      !entry.pending ||
      signal === undefined ||
      typeof signal.addEventListener !== 'function'
    ) {
      return entry.promise
    }
    let reject: (reason: unknown) => void
    const aborted = new Promise<never>((_resolve, rejectAborted) => {
      reject = rejectAborted
    })
    const onAbort = () => {
      // the caller's own reason, verbatim, as throwIfAborted would throw it
      reject(abortReason(signal))
    }
    // Removed by reference rather than through a `{ signal }` option. Node holds
    // that option's removal hook weakly, one per target, so a second listener
    // registered that way on the same signal orphans the first after a GC — and
    // an orphaned listener pins the entry and its value for the signal's life.
    signal.addEventListener('abort', onAbort, { once: true })
    // Losing this race leaves `entry.promise` unobserved here, which is safe
    // only because start() attaches its own handlers to it.
    return Promise.race([entry.promise, aborted]).finally(() => {
      signal.removeEventListener('abort', onAbort)
    })
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
   *
   * `undefined` too for a read every caller has already abandoned, which is not
   * a cached value but a rejection that has not landed yet.
   */
  getIfCached(key: K) {
    const cacheKey = this.toCacheKey(key)
    const entry = this.entries.get(cacheKey)
    if (!entry) {
      return undefined
    }
    if (this.isDoomed(entry)) {
      this.deleteKey(cacheKey)
      return undefined
    }
    this.touch(cacheKey, entry)
    return entry.promise
  }

  /**
   * Whether {@link get} would be answered from the cache, by a settled value or
   * a read in flight. False for a read every caller has abandoned, as it is for
   * {@link get} and {@link getIfCached}. The one lookup that changes nothing.
   */
  has(key: K) {
    const entry = this.entries.get(this.toCacheKey(key))
    return entry !== undefined && !this.isDoomed(entry)
  }

  delete(key: K) {
    this.deleteKey(this.toCacheKey(key))
  }

  clear() {
    this.entries.clear()
    this.shared?.budget.charge(this.shared.membership, -this.total)
    this.total = 0
    this.settledCount = 0
    this.stopSweep()
  }

  /**
   * Mark an entry most-recently-used, in both orders that word has here: its
   * position in {@link entries}, which {@link evict} and {@link lruSpare} walk,
   * and its {@link Entry.seq}, which a budget compares across caches.
   *
   * {@link lruSpare} takes an entry from map order and reports its seq, so the
   * two orders have to move together. This and {@link start} are the only
   * places either moves.
   */
  private touch(cacheKey: string, entry: Entry<V>) {
    this.entries.delete(cacheKey)
    this.entries.set(cacheKey, entry)
    entry.lastTouched = Date.now()
    entry.seq = this.stamp()
  }

  /** Only a budget compares these, so a cache without one has no order to keep. */
  private stamp() {
    return this.shared?.budget.nextSeq() ?? 0
  }

  /** In flight, but every caller waiting on it has already given up. */
  private isDoomed(entry: Entry<V>) {
    return entry.pending?.controller.signal.aborted === true
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
      if (!entry.pending && entry.lastTouched <= cutoff) {
        this.deleteKey(cacheKey)
      }
    }
    // Nothing settled left, rather than an empty map: a read that never settles
    // is never swept, and must not keep the timer ticking. If it does settle,
    // start() arms the timer again.
    if (this.settledCount === 0) {
      this.stopSweep()
    }
  }

  // The sweep runs on an interval because it is the one form of reclamation
  // that has to happen when nothing is calling in. It runs exactly when there
  // is something it could reclaim: armed by the first read to SETTLE, stopped
  // by the first sweep that finds no settled entry left.
  //
  // The timer holds the cache weakly, which is what makes a dispose() method
  // unnecessary: a pending timer is a GC root, so held strongly it kept a
  // dropped cache, and everything its fill closes over, alive until a sweep
  // emptied it — a whole idle timeout after the consumer let go.
  private startSweep() {
    const timeout = this.idleTimeoutMs
    if (timeout === undefined || this.sweepTimer !== undefined) {
      return
    }
    // A quarter of the timeout, so an idle entry is reclaimed within ~1.25x of
    // it, but no more often than once a second. Capped at what a timer can
    // hold: past 2^31-1 ms Node and browsers fire immediately instead.
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
    // Node holds the process open for a pending interval, and a library's
    // housekeeping must never be why a script fails to exit. Browsers return a
    // number, which has no unref.
    ;(timer as { unref?: () => void }).unref?.()
  }

  private stopSweep() {
    if (this.sweepTimer !== undefined) {
      clearInterval(this.sweepTimer)
      this.sweepTimer = undefined
    }
  }

  // The read runs under its own controller rather than any one caller's signal,
  // because it is shared: it must survive until every caller waiting on it has
  // given up. join() is what registers them.
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
      // Promise.resolve hands a native promise back untouched, so getIfCached
      // still returns the fill's own. What it adds is that an untyped fill
      // returning a bare value is a read like any other, where calling `.then`
      // on it threw after the entry was already in the map.
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
    // `.then(f, g)` rather than `.finally(f)` so the handler's own promise never
    // carries an unhandled rejection.
    void entry.promise.then(
      value => {
        // Weighed while the entry still reads as in flight, because sizeOf is
        // consumer code: if it deletes or clears from in here, the entry leaves
        // as the uncounted read it still is.
        const size = isCurrent() ? this.weigh(value) : undefined
        // false too if a later read replaced this key while this one ran
        const current = isCurrent()
        settle()
        if (current) {
          if (size === undefined) {
            // not deleteKey, which credits back a settled entry: this one was
            // never counted as one
            this.entries.delete(cacheKey)
          } else {
            // The idle clock starts when the value exists, so a slow read
            // still gets its whole timeout. Not a touch(): eviction order
            // stays the order reads were asked for in, since ordering by when
            // they landed keeps whatever was slowest to arrive.
            entry.lastTouched = Date.now()
            entry.size = size
            this.settledCount++
            this.total += size
            this.shared?.budget.charge(this.shared.membership, size)
            this.startSweep()
          }
        }
        this.evict()
        // after the local pass, so a cache that can get under its own ceiling
        // does that first and only then competes for the shared one
        this.shared?.budget.evict()
      },
      () => {
        // A failed read caches nothing, so the next caller starts over. Dropped
        // before settle(), so deleteKey sees the uncounted read it still is.
        if (isCurrent()) {
          this.deleteKey(cacheKey)
        }
        settle()
      },
    )
    return entry
  }

  /**
   * {@link SharedReadCacheOptions.sizeOf}, checked — `undefined` when it does
   * not answer with a weight, which drops the entry rather than keeping one the
   * budget cannot see.
   *
   * Checked because it is consumer code over consumer values: `v =>
   * v.byteLength` returns `undefined` on a value without the field, arithmetic
   * turns that into `NaN`, and `NaN` in `total` is permanent — `total <= limit`
   * is false forever after, so every settle evicts down to the last entry.
   *
   * Swallowed rather than rethrown. Thrown from here it would reject a promise
   * nothing holds, and carried into the entry's own promise it would fail a
   * read that succeeded and whose caller already has its value.
   */
  private weigh(value: V) {
    try {
      const size = this.sizeOf(value)
      return Number.isFinite(size) && size >= 0 ? size : undefined
    } catch {
      return undefined
    }
  }

  // Register a caller's interest, so the read survives until that caller has
  // given up too.
  private join(pending: PendingRead, signal?: AbortSignal) {
    if (signal === undefined || typeof signal.addEventListener !== 'function') {
      // Nothing here can learn that this caller gave up — it has no signal, or
      // a duck-typed `{ aborted }` that cannot be subscribed to — so the read
      // must not be cancelled out from under it.
      pending.pinned = true
    } else if (!signal.aborted && !pending.signals.has(signal)) {
      // `!signal.aborted` is unreachable through get(), which rejects such a
      // caller first. It stays because an abort listener never fires on a
      // signal that aborted before it was added: counted as a waiter, that
      // caller would make the read uncancellable for everyone, silently.
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

  private deleteKey(cacheKey: string) {
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
   * @internal — a budget asks; nothing else should.
   *
   * The least-recently-used settled entry, or `undefined` if this cache holds
   * at most one.
   */
  lruSpare() {
    if (this.settledCount <= 1) {
      return undefined
    }
    for (const [cacheKey, entry] of this.entries) {
      if (!entry.pending) {
        return { cacheKey, seq: entry.seq }
      }
    }
    return undefined
  }

  /** @internal — a budget evicting on this cache's behalf. */
  release(cacheKey: string) {
    this.deleteKey(cacheKey)
  }

  /**
   * Evict from the least-recently-used end.
   *
   * Reads still in flight are skipped: they have no weight to reclaim, and
   * dropping one would lose the de-duplication every caller joined to it is
   * relying on.
   *
   * The last settled entry is kept whatever the budget. A single value larger
   * than the whole budget is still worth holding — the caller needs it for the
   * request in flight, so dropping it only buys an immediate re-read.
   */
  private evict() {
    // also what keeps an unbounded cache, or one comfortably under its budget,
    // from building an iterator on every settle
    if (this.total <= this.limit) {
      return
    }
    for (const [cacheKey, entry] of this.entries) {
      if (this.total <= this.limit || this.settledCount <= 1) {
        break
      }
      if (!entry.pending) {
        this.deleteKey(cacheKey)
      }
    }
  }
}
