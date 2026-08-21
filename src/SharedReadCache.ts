import { abortReason, throwIfAborted } from './throwIfAborted.ts'

import type { BudgetMember, SharedBudget } from './SharedBudget.ts'

/**
 * Node holds the process open for a pending interval, and a library's
 * housekeeping timer must never be the reason a script fails to exit.
 *
 * Duck-typed rather than cast, because the return of `setInterval` is a
 * `Timeout` object in Node and a plain number in browsers and workers, and this
 * package is built once for both.
 */
function unrefIfPossible(timer: unknown) {
  if (
    typeof timer === 'object' &&
    timer !== null &&
    'unref' in timer &&
    typeof timer.unref === 'function'
  ) {
    timer.unref()
  }
}

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
  /**
   * true while this read is counted in {@link SharedReadCache.pending}, which
   * is what the batch policy waits on. Cleared when the read settles, and
   * early if the cache drops it or every caller gives up — see
   * {@link SharedReadCache.detach}.
   */
  counted: boolean
  /** 0 until the read settles and the value can be weighed */
  size: number
  /**
   * The batch this entry was last touched by; only meaningful under the batch
   * policy, which spares everything carrying the batch in flight's number.
   * Compared against a counter rather than cleared entry by entry, so ending a
   * batch is O(1) instead of O(entries).
   */
  batch: number
  /**
   * `Date.now()` at the last {@link SharedReadCache.get} or
   * {@link SharedReadCache.getIfCached} that resolved to this entry.
   * Only meaningful when {@link SharedReadCacheOptions.idleTimeoutMs} is set.
   */
  lastTouched: number
  /**
   * This cache's budget's stamp at the same moment, for the cross-cache LRU
   * order that budget evicts by; 0 when there is no budget, which is when
   * nothing compares entries across caches. See {@link SharedBudget.nextSeq}.
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
   * When to evict. Defaults to `'lru'`.
   *
   * `'lru'` evicts as each read settles, so the budget is a hard ceiling.
   *
   * `'batch'` waits until no reads are in flight and then spares everything
   * that batch touched. The case for it: a single request that starts many
   * reads at once and holds all of their values until it returns: evicting one
   * mid-request frees nothing, because the caller is still holding it, but it
   * does guarantee the next identical request re-reads it.
   *
   * **Try a bigger {@link maxSize} first.** @gmod/cram adopted `'batch'` on a
   * 117ms-against-12ms measurement and then dropped it again, and the sequence
   * is the useful part. That measurement was taken with a budget 2.75x *below*
   * the request's working set. Raising the budget above the working set made
   * the two policies measurably identical — same re-read counts, times inside
   * noise — because a request that fits has nothing to evict mid-flight
   * whichever policy is in force. @gmod/bam measured the same thing from the
   * other side: on a pan workload over an undersized budget, `'batch'` did not
   * rescue it at all, matching `'lru'` re-read for re-read while retaining 1.7x
   * the memory.
   *
   * So `'batch'` only changes anything when a batch exceeds the budget, and
   * what it does there is exceed the budget: cram measured it holding 420,000
   * records against a stated limit of 20,000. That is the documented trade — a
   * batch touching more than the whole budget leaves the cache over it until
   * the next batch lands — and it is worth being clear that it is the whole
   * mechanism, not a side effect. A consumer lowering the budget to constrain
   * memory will not get what it asked for.
   *
   * Reach for it when a too-small budget is genuinely forced on you and the
   * workload is repeated identical requests. Otherwise size the budget above
   * one request and leave this alone.
   */
  evictionPolicy?: 'lru' | 'batch'
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
  budget?: SharedBudget
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
  private budget?: SharedBudget
  /** how this cache reports its weight to {@link budget}; see SharedBudget */
  private membership?: ReturnType<SharedBudget['register']>
  private fill?: (key: K, signal: AbortSignal) => Promise<V>
  private sizeOf: (value: V) => number
  private toCacheKey: (key: K) => string
  private evictionPolicy: 'lru' | 'batch'
  /** reads still in flight, so the batch policy knows when the batch is done */
  private pending = 0
  /** the batch in flight; see {@link Entry.batch} */
  private batch = 0
  private idleTimeoutMs?: number
  private sweepTimer?: ReturnType<typeof setInterval>

  constructor({
    fill,
    maxSize = Infinity,
    sizeOf = () => 1,
    cacheKey = (key: K) => String(key),
    evictionPolicy = 'lru',
    idleTimeoutMs = 0,
    budget,
    // Defaulted, because a cache with no options at all is a real shape and a
    // common one: the memo, whose fill is a closure passed per get() call. Five
    // of these exist across @gmod/bam, @gmod/tabix and indexedfasta-js, and
    // every one of them was written `new SharedReadCache({})`.
  }: SharedReadCacheOptions<K, V> = {}) {
    this.fill = fill
    this.evictionPolicy = evictionPolicy
    this.limit = maxSize
    this.budget = budget
    this.membership = budget?.register(this)
    this.sizeOf = sizeOf
    this.toCacheKey = cacheKey
    // 0, undefined and a nonsense negative all mean "no idle eviction", so the
    // rest of the class has one thing to check rather than three
    this.idleTimeoutMs = idleTimeoutMs > 0 ? idleTimeoutMs : undefined
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
      // A read every caller has abandoned is on its way out but may not have
      // noticed yet. Start a fresh one rather than join one already doomed —
      // joining it means inheriting a cancellation nothing to do with us.
      if (this.isDoomed(entry)) {
        this.deleteKey(cacheKey)
        entry = undefined
      } else {
        this.touch(cacheKey, entry)
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
      const value = await this.settleFor(entry, signal)
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
   * The shared read, but a caller that gives up while it is still running is
   * released now rather than whenever that read lands.
   *
   * Awaiting `entry.promise` alone made abort() a request rather than an
   * answer. The read is shared, so one caller aborting deliberately does not
   * stop it — which left that caller pending until every *other* waiter was
   * done: two callers on a 30s read, one aborts, and it waits the full 30s to
   * be told about a cancellation it asked for itself. A fill that ignores the
   * signal — a stalled fetch — never released it at all. Panning a genome
   * browser is exactly this shape, since the abandoned blocks are the ones
   * whose siblings are still wanted.
   *
   * Only for a read still in flight, and only for a signal that can be
   * subscribed to. A settled entry has nothing left to wait for, and nothing
   * here can learn when a duck-typed signal fires; both fall back to the
   * post-await {@link throwIfAborted} in {@link get}, which is all either ever
   * needed.
   */
  private settleFor(entry: Entry<V>, signal?: AbortSignal) {
    if (
      entry.settled ||
      signal === undefined ||
      typeof signal.addEventListener !== 'function'
    ) {
      return entry.promise
    }
    // Aborted once the race is decided, to take this listener back off the
    // caller's signal. Without it a long-lived signal collects one listener per
    // get() it ever made, which is the leak {@link Entry.dispose} exists to
    // avoid on the other listener.
    const unsubscribe = new AbortController()
    return Promise.race([
      // Losing this race leaves `entry.promise` unobserved here, which is safe
      // only because start() attaches its own handlers to it — otherwise a read
      // that failed after its last caller walked away would surface as an
      // unhandled rejection.
      entry.promise,
      new Promise<never>((_resolve, reject) => {
        signal.addEventListener(
          'abort',
          () => {
            // the caller's own reason, verbatim, exactly as throwIfAborted
            // would have thrown it -- see abortReason
            // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
            reject(abortReason(signal))
          },
          { once: true, signal: unsubscribe.signal },
        )
      }),
    ]).finally(() => {
      unsubscribe.abort()
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
    // A read every caller has abandoned is not a cached value, it is a
    // rejection on its way to happening. Handing it back gives this caller
    // someone else's cancellation, which it has no way to read as anything but
    // a failed read — so answer as if the entry were not here, which is what
    // get() effectively does by starting a fresh read in its place.
    if (this.isDoomed(entry)) {
      this.deleteKey(cacheKey)
      return undefined
    }
    this.touch(cacheKey, entry)
    return entry.promise
  }

  has(key: K) {
    const entry = this.entries.get(this.toCacheKey(key))
    // A read every caller has abandoned is not a cached value, so `has` says so
    // — {@link get} would start a fresh read for it and {@link getIfCached}
    // would answer `undefined`, and three lookups disagreeing about one key is
    // no use to anyone. Unlike those two this does not drop the entry, because
    // this is the one lookup that leaves the cache alone.
    return entry !== undefined && !this.isDoomed(entry)
  }

  delete(key: K) {
    this.deleteKey(this.toCacheKey(key))
  }

  clear() {
    for (const entry of this.entries.values()) {
      this.detach(entry)
    }
    this.entries.clear()
    this.charge(-this.total)
    this.total = 0
    this.settledCount = 0
    this.stopSweep()
  }

  /**
   * Mark an entry most-recently-used, in both orders that word has here: its
   * position in {@link entries}, which {@link evict} and {@link lruSpare} walk,
   * and its {@link Entry.seq}, which {@link SharedBudget} compares across
   * caches.
   *
   * The two have to move together, and this is the only place either moves
   * after {@link start} places a new entry at the front with a matching seq —
   * which is the point of it being one function. {@link lruSpare} takes an
   * entry from map order and reports *its* seq, so the budget's claim to evict
   * the globally least-recently-used entry holds only while the two orders
   * agree. They did not: settling stamped a fresh seq without moving the entry,
   * so any read that settled out of the order it was started in left its cache
   * offering the budget a seq belonging to some other entry.
   */
  private touch(cacheKey: string, entry: Entry<V>) {
    // re-insert so Map iteration order stays least-recently-used first
    this.entries.delete(cacheKey)
    this.entries.set(cacheKey, entry)
    entry.batch = this.batch
    entry.lastTouched = Date.now()
    entry.seq = this.stamp()
  }

  /**
   * This entry's place in the recency order {@link SharedBudget} evicts by.
   * Only a budget compares these, so a cache without one has no order to keep.
   */
  private stamp() {
    return this.budget ? this.budget.nextSeq() : 0
  }

  /** In flight, but every caller waiting on it has already given up. */
  private isDoomed(entry: Entry<V>) {
    return !entry.settled && entry.controller.signal.aborted
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
    let sweepable = 0
    for (const [cacheKey, entry] of this.entries) {
      // in-flight entries are skipped for the same reason evict() skips them:
      // no weight to reclaim, and dropping one loses the de-duplication its
      // waiters joined for
      if (!entry.settled) {
        continue
      }
      if (entry.lastTouched <= cutoff) {
        this.deleteKey(cacheKey)
      } else {
        sweepable++
      }
    }
    // Stop when nothing SETTLED is left, rather than when the map is empty. A
    // read that never settles — a stalled fetch on a dead connection, which is
    // exactly when a consumer gives up and drops the cache — is never swept, so
    // `entries.size` never reached zero and the timer ticked forever. Since the
    // timer roots this cache, and this cache roots whatever its fill closes
    // over, that one hung read pinned the whole graph indefinitely. Should it
    // ever settle, settle() arms the timer again.
    if (sweepable === 0) {
      this.stopSweep()
    }
  }

  // The sweep runs on an interval because it is the one form of reclamation
  // that has to happen when nothing is calling in — a lazy check on get() would
  // never fire on precisely the idle consumer this exists for.
  //
  // It runs exactly when there is something it could reclaim: armed by the
  // first read to SETTLE, stopped by the first sweep that finds no settled
  // entry left. In-flight reads arm nothing, because the sweep would skip them
  // anyway. That is also what makes a dispose() method unnecessary. A consumer
  // that drops the cache without clearing it leaves one timer alive for at most
  // a timeout plus a sweep interval, after which the sweep reclaims what it can
  // and stops itself, and the whole thing becomes garbage.
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
    unrefIfPossible(this.sweepTimer)
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
      // Weighed here, inside the entry's own promise, rather than in a handler
      // hanging off it. `sizeOf` is consumer code running on consumer values —
      // `v => v.byteLength` over a `V` that can be undefined is the obvious way
      // to reach it — and thrown from that handler it rejected a promise
      // nothing was holding, which is Node's `unhandledRejection` and so, since
      // v15, the end of the process. The caller that triggered it meanwhile
      // watched its own read succeed.
      //
      // On the entry's promise it fails that read instead, which is a thing
      // this class already knows how to do: the rejection path drops the key
      // before marking the entry settled, so nothing is charged, nothing is
      // counted, and the next caller starts over. A value the cache cannot
      // weigh is a value it cannot hold against a budget.
      promise: run(controller.signal).then(value => {
        entry.size = this.weigh(value)
        return value
      }),
      signals: new Set(),
      pinned: false,
      controller,
      dispose: new AbortController(),
      settled: false,
      counted: true,
      size: 0,
      batch: this.batch,
      lastTouched: Date.now(),
      seq: this.stamp(),
    }
    this.entries.set(cacheKey, entry)
    this.pending++
    const settle = () => {
      entry.settled = true
      this.detach(entry)
      // nothing reads these once the read has settled, and holding them would
      // pin each caller's AbortController behind this entry
      entry.dispose.abort()
      entry.signals.clear()
    }
    // `.then(f, g)` rather than `.finally(f)` so the handler's own promise never
    // carries an unhandled rejection.
    void entry.promise.then(
      () => {
        settle()
        // a later read may have replaced this key while this one was in
        // flight; charging its weight to that entry would double-count
        if (this.entries.get(cacheKey) === entry) {
          // The idle clock starts when the value exists, not when the read for
          // it began. Stamped only at start(), an entry lost its whole fill
          // duration out of its idle budget — and one whose fill outran
          // idleTimeoutMs arrived already expired, swept on the very next tick,
          // so the query that paid for that read never got a single hit off it.
          //
          // Deliberately not a touch(). "How long since" and "which came first"
          // are different questions, and only the first one is about the value
          // existing: a read's *latency* is a property of the transport, not of
          // how the consumer is using the cache, so ordering evictions by it
          // preferentially keeps whatever was slowest to arrive. In @gmod/tabix
          // that is the largest chunk in the query, which is the last thing a
          // budget should be retaining.
          entry.lastTouched = Date.now()
          this.settledCount++
          this.total += entry.size
          this.charge(entry.size)
          // the first thing the sweep could actually reclaim, so this is where
          // the timer belongs — see startSweep
          this.startSweep()
        }
        this.maybeEvict()
      },
      () => {
        // a failed read caches nothing, so the next caller starts over rather
        // than inheriting the failure. Dropped before settle() marks it, so it
        // is never one of the settledCount entries deleteKey credits back.
        if (this.entries.get(cacheKey) === entry) {
          this.deleteKey(cacheKey)
        }
        settle()
        this.maybeEvict()
      },
    )
    return entry
  }

  /**
   * {@link SharedReadCacheOptions.sizeOf}, checked. A weight has to be a
   * non-negative finite number or the budget it is summed into stops meaning
   * anything, and `NaN` is the reachable case: `v => v.byteLength` over a value
   * that has no `byteLength` returns `undefined`, and arithmetic makes that
   * `NaN` rather than an error. One of those poisons `total` permanently —
   * `total <= limit` is then false forever, so every settle evicts down to the
   * last entry and the cache silently stops caching. Measured at five entries
   * against a `maxSize` of 100 collapsing to one.
   *
   * Thrown rather than corrected, for the same reason a `sizeOf` that throws is
   * left to fail its read: guessing a weight for a value the consumer could not
   * weigh would bound nothing and hide the bug.
   */
  private weigh(value: V) {
    const size = this.sizeOf(value)
    if (!Number.isFinite(size) || size < 0) {
      throw new TypeError(
        `sizeOf returned ${String(size)}, which cannot be weighed against a budget`,
      )
    }
    return size
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
    } else if (typeof signal.addEventListener !== 'function') {
      // A duck-typed signal, not yet aborted. `{ aborted: false }` is what
      // consumers hand-roll — @gmod/bam's test/csi.test.ts is one, and
      // {@link throwIfAborted} exists because they are real — and subscribing
      // to it was a TypeError rather than a read. It fired on the FIRST call
      // that reached a cache with such a signal, so a consumer passing one got
      // `signal.addEventListener is not a function` instead of its data.
      //
      // Pinned, for the same reason a signal-free caller is: nothing here can
      // ever learn that this caller gave up, so the honest reading is that it
      // cannot, and a read it is waiting on must not be cancelled out from
      // under it. The caller is still told about its own cancellation — get()
      // re-checks `aborted` after the read settles — so what it loses is only
      // the ability to stop the read early, which is what an unsubscribable
      // signal cannot ask for anyway.
      entry.pinned = true
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
            // Nobody is waiting on this read any more, so nobody is holding
            // its value, so it is not what the batch policy defers eviction
            // for. Left counted it was: the policy waits for `pending` to
            // reach zero, and a read cancelled against a transport that
            // ignores its signal never settles to decrement it — one stalled
            // fetch and the cache never evicted again, however far over the
            // budget it went.
            this.detach(entry)
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
      // An entry the cache no longer holds is not part of any batch of its
      // reads, whether it has settled or not; see detach.
      this.detach(entry)
      if (entry.settled) {
        this.settledCount--
      }
      this.total -= entry.size
      this.charge(-entry.size)
    }
  }

  /**
   * Stop counting a read among the {@link pending} ones the batch policy waits
   * for. Idempotent, because a read can leave that count either by settling or
   * by the cache giving up on it first, and both can happen to the same read.
   *
   * The read itself is untouched: a caller still awaiting one the cache has
   * dropped gets its value as normal. What ends is only its claim on the batch,
   * which it has no business holding open once nothing will use the result.
   */
  private detach(entry: Entry<V>) {
    if (entry.counted) {
      entry.counted = false
      this.pending--
    }
  }

  private charge(delta: number) {
    if (this.budget && this.membership) {
      this.budget.charge(this.membership, delta)
    }
  }

  /**
   * @internal — {@link SharedBudget} asks; nothing else should.
   *
   * The least-recently-used settled entry, or `undefined` if this cache holds
   * at most one. Iteration order is least-recently-used first, so this returns
   * on the first settled entry it sees rather than walking the map.
   */
  lruSpare() {
    // Before the scan: the budget asks every member on every eviction, and a
    // member with nothing to spare would otherwise walk past all of its
    // in-flight reads to discover that.
    if (this.settledCount <= 1) {
      return undefined
    }
    for (const [cacheKey, entry] of this.entries) {
      // in flight: no weight to reclaim, and dropping one loses the
      // de-duplication its waiters joined for
      if (entry.settled) {
        return { cacheKey, seq: entry.seq }
      }
    }
    return undefined
  }

  /** @internal — {@link SharedBudget} evicting on this cache's behalf. */
  release(cacheKey: string) {
    this.deleteKey(cacheKey)
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
      // Ends the batch, and belongs here rather than in evict() because ending
      // one is what *settling* the last read of it means. Down in evict() it
      // also ran on the maxSize setter, which ends a batch still in flight: its
      // entries then age out the instant they settle, so a consumer shedding
      // memory mid-request silently got lru behaviour out of a batch cache. It
      // sat below evict()'s `limit === Infinity` guard too, so a batch cache
      // that started unbounded never advanced at all, and imposing a budget on
      // one later spared every entry it had ever held.
      //
      // Bumping the number the survivors are compared against ages every one of
      // them out at once, where clearing a mark per entry was O(entries) on
      // every batch — including the batches under budget, which reach here only
      // to do that.
      if (this.evictionPolicy === 'batch') {
        this.batch++
      }
      // after the local pass, so a cache that can get under its own ceiling
      // does that first and only then competes for the shared one
      this.budget?.evict()
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
        if (entry.batch !== this.batch && entry.settled) {
          this.deleteKey(cacheKey)
        }
      }
      return
    }

    // Before the loop below, which a cache comfortably under its budget would
    // otherwise enter and leave for nothing on every settle.
    if (this.total <= this.limit) {
      return
    }

    for (const [cacheKey, entry] of this.entries) {
      if (this.total <= this.limit || this.settledCount <= 1) {
        break
      }
      if (entry.settled) {
        this.deleteKey(cacheKey)
      }
    }
  }
}
