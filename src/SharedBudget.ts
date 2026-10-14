/** What a {@link SharedBudget} needs from a cache. */
export interface BudgetMember {
  /**
   * The least-recently-used settled entry this member will give up, with
   * `last` set when it is the member's only one. Without `offerLast` a member
   * keeps its last entry. Both are optional so that members and budgets from
   * different installs of this package still pair up.
   */
  lruSpare(
    offerLast?: boolean,
  ): { cacheKey: string; seq: number; last?: boolean } | undefined
  /** Drop the entry {@link lruSpare} named, crediting its weight back. */
  release(cacheKey: string): void
}

/** The handle a member reports its weight through. */
export interface BudgetMembership {
  /** weight this member currently contributes to the budget's total */
  held: number
}

/**
 * The type of a cache's `budget` option. An interface rather than the
 * {@link SharedBudget} class, so the budget and its caches can come from
 * different installs of this package; changing it is a breaking change.
 */
export interface Budget {
  register(member: BudgetMember): BudgetMembership
  charge(membership: BudgetMembership, delta: number): void
  /** The next stamp in the recency order shared by every member. */
  nextSeq(): number
  evict(): void
}

interface Membership extends BudgetMembership {
  ref: WeakRef<BudgetMember>
}

/**
 * One memory budget shared by several caches, evicting globally
 * least-recently-used across all of them. Every member must weigh in the same
 * unit. Members are held weakly, and a collected member's weight is credited
 * back on the next pass. See docs/memory.md.
 */
export class SharedBudget implements Budget {
  private members = new Set<Membership>()
  private budgetLimit: number
  // a module-level counter would exist twice when a consumer loads both the
  // ESM and CJS builds; see docs/memory.md
  private seq = 0
  private heldTotal = 0

  constructor(limit: number) {
    this.budgetLimit = limit
  }

  /** Settled weight held across every live member. */
  get total() {
    this.prune()
    return this.heldTotal
  }

  get limit() {
    return this.budgetLimit
  }

  /** Lowering the limit evicts now. */
  set limit(limit: number) {
    this.budgetLimit = limit
    this.evict()
  }

  /** Number of members still alive. Exposed for tests. */
  get size() {
    this.prune()
    return this.members.size
  }

  register(member: BudgetMember): BudgetMembership {
    const membership = { held: 0, ref: new WeakRef(member) }
    this.members.add(membership)
    return membership
  }

  /** @internal */
  nextSeq() {
    return this.seq++
  }

  charge(membership: BudgetMembership, delta: number) {
    membership.held += delta
    this.heldTotal += delta
  }

  /**
   * Evict globally least-recently-used settled entries until back under the
   * limit, keeping reads in flight and the one newest settled entry.
   */
  evict() {
    // before the limit check, so an unlimited budget still drops collected
    // members
    this.prune()
    while (this.heldTotal > this.budgetLimit) {
      let victim: BudgetMember | undefined
      let spare: ReturnType<BudgetMember['lruSpare']>
      let offers = 0
      for (const membership of this.members) {
        const member = membership.ref.deref()
        const offer = member?.lruSpare(true)
        if (member && offer) {
          offers++
          if (!spare || offer.seq < spare.seq) {
            victim = member
            spare = offer
          }
        }
      }
      if (!victim || !spare || (offers === 1 && spare.last)) {
        break
      }
      victim.release(spare.cacheKey)
    }
  }

  private prune() {
    for (const membership of this.members) {
      if (membership.ref.deref() === undefined) {
        this.heldTotal -= membership.held
        this.members.delete(membership)
      }
    }
  }
}
