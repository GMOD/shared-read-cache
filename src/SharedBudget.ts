/**
 * What a {@link SharedBudget} needs from a cache. Implemented by
 * {@link SharedReadCache}; there is no reason for a consumer to write one.
 */
export interface BudgetMember {
  /**
   * The least-recently-used settled entry this member is willing to give up,
   * or `undefined` if it has none to spare.
   *
   * A member never offers its last settled entry, for the same reason a cache
   * with a budget of its own keeps it: the caller needs that value for the
   * request in flight, so dropping it only buys an immediate re-read.
   */
  lruSpare(): { cacheKey: string; seq: number } | undefined
  /** Drop the entry {@link lruSpare} named, crediting its weight back. */
  release(cacheKey: string): void
}

/**
 * A membership handle. The cache keeps this and reports its weight through it;
 * the budget keeps it too, so that a cache which has been collected can still
 * have its last known weight subtracted from the total.
 */
class Membership {
  /** weight this member currently contributes to {@link SharedBudget.total} */
  held = 0
  readonly ref: WeakRef<BudgetMember>

  constructor(member: BudgetMember) {
    this.ref = new WeakRef(member)
  }
}

/**
 * One memory budget shared by several caches, evicting globally
 * least-recently-used across all of them.
 *
 * ## Why this exists
 *
 * {@link SharedReadCacheOptions.maxSize} is per cache, and a consumer that
 * opens one cache per file multiplies it. @gmod/bam's 1 GB default is sized so
 * a single track's pan never thrashes; jbrowse holds one `BamFile` per open
 * track, so three moderately deep alignments tracks browsing eight windows
 * measured 1109 MB retained and 1665 MB RSS — with **no cache anywhere near
 * its own ceiling**, so not one byte of that was the budget's doing. Per-file
 * ceilings do not bound a consumer that scales the number of files.
 *
 * ## Why not just divide the ceiling by the file count
 *
 * Because that walks into the cliff the per-file number exists to avoid. A
 * budget below one query's working set does not cache less, it caches
 * *nothing* — each value is evicted before the next pan can reuse it, so the
 * hit rate is zero and the memory is retained anyway. On that same three-track
 * workload, 1 GB split as 342 MB each cost 16 refills on the revisit; split
 * eight ways as 128 MB each it cost 101, against 98 for the cold pass. Worse
 * than no cache at all.
 *
 * A shared budget does not have that failure, because a member yields only
 * what is globally least-recently-used. Tracks the reader is not looking at
 * age out and hand their space to the one being panned, so the active track
 * keeps a working set whatever the track count — which is exactly what an
 * equal split cannot do.
 *
 * ## Every member must weigh in the same unit
 *
 * {@link total} is a sum over members, so it means nothing unless their
 * {@link SharedReadCacheOptions.sizeOf} agree. This is not hypothetical across
 * these packages: @gmod/bam and @gmod/tabix weigh decompressed bytes, @gmod/bbi
 * weighs entries, and @gmod/cram weighs decoded *records* — because a decoded
 * record has no cheap size. A budget holding a bam cache and a cram cache would
 * be adding bytes to records and bounding neither.
 *
 * Nothing here can check that, since `sizeOf` is opaque by design. Group
 * members by unit and give each group its own budget.
 *
 * ## Members are held weakly
 *
 * A long-lived budget must never be the reason a cache stays reachable. The
 * consumer this is for keeps one budget per worker and one cache per open
 * track, and closing a track reclaims by dropping the last strong reference to
 * the adapter — a budget holding its members strongly would silently convert
 * that into a leak, which is the exact bug it is meant to prevent. So the
 * budget holds a `WeakRef` to each cache and its last known weight beside it;
 * a collected member is pruned, and its weight credited back, on the next
 * eviction pass. No `unregister` call for a consumer to forget.
 */
export class SharedBudget {
  private members = new Set<Membership>()
  private budgetLimit: number
  /**
   * Ticks on every touch across every member, giving the total order over
   * entries that {@link evict} picks its victim by.
   *
   * `lastTouched` cannot do that job. `Date.now()` has millisecond resolution,
   * so a burst of cache hits inside one millisecond all carry the same stamp,
   * and a tie resolves to whichever member happened to be scanned last rather
   * than to anything about recency. Wall-clock is still what a cache's idle
   * sweep needs, so the two coexist: one answers "how long since", the other
   * "which came first".
   *
   * It lives here, on the object the members share, rather than in a module
   * variable beside the cache. This package ships an ESM build and a CJS one,
   * so a consumer whose dependency graph reaches both gets two copies of that
   * module and two counters, each starting at zero — and members from the two
   * then offered this budget colliding stamps. Measured on one budget holding
   * a cache from each build: it evicted the second-newest entry of seven and
   * kept the genuinely oldest, which is the below-the-working-set cliff this
   * class exists to avoid, arrived at through a build artifact rather than
   * through any configuration. A shared budget is by definition one object, so
   * a counter on it is one counter however many copies of the class exist.
   */
  private seq = 0

  private heldTotal = 0

  /**
   * Sum of the settled weight held across every member.
   *
   * An accessor, because a member that has been collected owes nothing and this
   * is the number a consumer reports memory from. As a plain field it was only
   * corrected when something happened to call {@link prune} — {@link evict} or
   * {@link size} — so a budget sitting under its limit, which is a budget with
   * no reason to evict, went on counting caches that no longer exist for as
   * long as nothing else happened. That is the same 10,200-against-400 the
   * pruning order inside {@link evict} was fixed for, reached by sitting still
   * rather than by having no limit.
   */
  get total() {
    this.prune()
    return this.heldTotal
  }

  constructor(limit: number) {
    this.budgetLimit = limit
  }

  get limit() {
    return this.budgetLimit
  }

  /**
   * Accessor rather than a plain field for the same reason
   * {@link SharedReadCache.maxSize} is one: lowering the budget frees memory
   * now, rather than whenever some member next happens to settle a read.
   */
  set limit(limit: number) {
    this.budgetLimit = limit
    this.evict()
  }

  /** Number of members still alive. Exposed for tests. */
  get size() {
    this.prune()
    return this.members.size
  }

  /**
   * Enrol a cache. Returns the handle it reports its weight through — the
   * budget never asks a member for its weight, because a member that has been
   * collected still owes what it held.
   */
  register(member: BudgetMember) {
    const membership = new Membership(member)
    this.members.add(membership)
    return membership
  }

  /**
   * @internal — the next stamp in this budget's recency order. Members ask on
   * every touch; nothing else should.
   */
  nextSeq() {
    return this.seq++
  }

  /** Adjust a member's contribution, and the total with it. */
  charge(membership: Membership, delta: number) {
    membership.held += delta
    this.heldTotal += delta
  }

  /**
   * Evict globally least-recently-used settled entries until back under the
   * limit, or until no member will give up another.
   */
  evict() {
    // Before the limit is consulted, because pruning is not part of evicting:
    // {@link total} is a documented public number and a member that has been
    // collected owes nothing, whether or not there is a limit to compare it
    // against. Guarded the other way round, an unlimited budget returned here
    // and so never pruned at all — it reported 10,200 against members actually
    // holding 400, and kept a Membership for every cache ever registered, which
    // is the accumulation the weak refs exist to avoid.
    this.prune()
    if (this.budgetLimit === Infinity) {
      return
    }
    while (this.heldTotal > this.budgetLimit) {
      let victimKey: string | undefined
      let victimAt = Infinity
      let victim: BudgetMember | undefined
      for (const membership of this.members) {
        const member = membership.ref.deref()
        const spare = member?.lruSpare()
        if (spare && spare.seq < victimAt) {
          victimAt = spare.seq
          victimKey = spare.cacheKey
          victim = member
        }
      }
      // Everything left is a member's last settled entry or a read in flight.
      // Both are kept whatever the budget, so this is as low as it goes.
      if (!victim || victimKey === undefined) {
        break
      }
      victim.release(victimKey)
    }
  }

  /** Drop collected members, crediting back what they were still counted for. */
  private prune() {
    for (const membership of this.members) {
      if (membership.ref.deref() === undefined) {
        this.heldTotal -= membership.held
        this.members.delete(membership)
      }
    }
  }
}
