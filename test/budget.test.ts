import { expect, test, vi } from 'vitest'

import { SharedBudget, SharedReadCache } from '../src/index.ts'

/** A cache of fixed-weight values, so a budget is countable in entries. */
function weighed(budget: SharedBudget, weight: number) {
  return new SharedReadCache<string, string>({
    budget,
    sizeOf: () => weight,
    // eslint-disable-next-line @typescript-eslint/require-await
    fill: async key => key,
  })
}

test('the budget is the sum across members, not a ceiling on each', async () => {
  const budget = new SharedBudget(300)
  const a = weighed(budget, 100)
  const b = weighed(budget, 100)

  await a.get('a1')
  await b.get('b1')
  await a.get('a2')
  expect(budget.total).toBe(300)
  expect(a.size + b.size).toBe(3)

  // a fourth entry puts the SUM over, even though no member is over anything
  await b.get('b2')
  expect(budget.total).toBe(300)
  expect(a.size + b.size).toBe(3)
})

test('evicts globally least-recently-used, across members', async () => {
  const budget = new SharedBudget(300)
  const a = weighed(budget, 100)
  const b = weighed(budget, 100)

  await a.get('oldest')
  await b.get('middle')
  await a.get('newest')

  // the least-recently-used entry in the system belongs to `a`, so `a` is the
  // one that gives it up even though `b` is the cache that just settled a read
  await b.get('trigger')
  expect(a.has('oldest')).toBe(false)
  expect(b.has('middle')).toBe(true)
  expect(a.has('newest')).toBe(true)
  expect(b.has('trigger')).toBe(true)
})

test('a re-read moves an entry out of the firing line', async () => {
  const budget = new SharedBudget(300)
  const a = weighed(budget, 100)
  const b = weighed(budget, 100)

  await a.get('a1')
  await b.get('b1')
  await a.get('a2')
  // a1 was the oldest; reading it again makes b1 the oldest instead
  await a.get('a1')

  await b.get('b2')
  expect(a.has('a1')).toBe(true)
  expect(b.has('b1')).toBe(false)
})

// The property an equal split cannot provide, and the reason this exists: a
// member nobody is reading hands its space to the one being worked, so the
// active member keeps a whole working set however many members there are.
test('an idle member yields its space to a busy one', async () => {
  const budget = new SharedBudget(500)
  const idle = weighed(budget, 100)
  const busy = weighed(budget, 100)

  for (const key of ['i1', 'i2', 'i3', 'i4']) {
    await idle.get(key)
  }
  expect(idle.size).toBe(4)

  // busy pans over five keys twice; under an equal split it would hold at most
  // two or three and refill on the second pass
  const pan = ['p1', 'p2', 'p3', 'p4']
  let fills = 0
  for (const pass of [0, 1]) {
    for (const key of pan) {
      // eslint-disable-next-line @typescript-eslint/require-await
      await busy.get(key, undefined, async () => {
        fills++
        return `${pass}:${key}`
      })
    }
  }

  expect(fills).toBe(4) // second pass was all hits
  expect(busy.size).toBe(4)
  expect(idle.size).toBe(1) // gave up everything it could spare
  expect(budget.total).toBe(500)
})

test('a member keeps its last settled entry whatever the budget', async () => {
  const budget = new SharedBudget(100)
  const a = weighed(budget, 100)
  const b = weighed(budget, 100)

  await a.get('a1')
  await b.get('b1')

  // both are over the shared budget together, but neither will give up its
  // only entry -- the caller needs it for the request in flight
  expect(a.size).toBe(1)
  expect(b.size).toBe(1)
  expect(budget.total).toBe(200)
  expect(a.lruSpare()).toBeUndefined()
})

test('lowering the limit evicts now, not on the next read', async () => {
  const budget = new SharedBudget(1000)
  const a = weighed(budget, 100)
  const b = weighed(budget, 100)

  for (const key of ['a1', 'a2', 'a3']) {
    await a.get(key)
  }
  for (const key of ['b1', 'b2', 'b3']) {
    await b.get(key)
  }
  expect(budget.total).toBe(600)

  budget.limit = 200
  expect(budget.total).toBe(200)
  // the two most recent survive; the four oldest went, oldest first
  expect(a.has('a3')).toBe(true)
  expect(b.has('b3')).toBe(true)
  expect(a.has('a1')).toBe(false)
})

test('clearing a member credits its weight back', async () => {
  const budget = new SharedBudget(1000)
  const a = weighed(budget, 100)
  const b = weighed(budget, 100)

  await a.get('a1')
  await a.get('a2')
  await b.get('b1')
  expect(budget.total).toBe(300)

  a.clear()
  expect(budget.total).toBe(100)
  expect(budget.size).toBe(2)
})

test('a per-cache ceiling still applies alongside the shared one', async () => {
  const budget = new SharedBudget(1000)
  const capped = new SharedReadCache<string, string>({
    budget,
    maxSize: 200,
    sizeOf: () => 100,
    // eslint-disable-next-line @typescript-eslint/require-await
    fill: async key => key,
  })

  for (const key of ['c1', 'c2', 'c3']) {
    await capped.get(key)
  }
  // nowhere near the shared budget, but its own ceiling binds
  expect(capped.size).toBe(2)
  expect(budget.total).toBe(200)
})

test('an unlimited budget never evicts', async () => {
  const budget = new SharedBudget(Infinity)
  const a = weighed(budget, 100)

  for (const key of ['a1', 'a2', 'a3', 'a4']) {
    await a.get(key)
  }
  expect(a.size).toBe(4)
  expect(budget.total).toBe(400)
})

/**
 * A cache whose reads park until the test resolves them by key, so reads can be
 * made to settle in an order other than the one they were started in.
 */
function parked(budget: SharedBudget, weight: number) {
  const resolvers = new Map<string, (value: string) => void>()
  const cache = new SharedReadCache<string, string>({
    budget,
    sizeOf: () => weight,
    fill: key =>
      new Promise<string>(resolve => {
        resolvers.set(key, resolve)
      }),
  })
  return {
    cache,
    /** settle one parked read and let its handlers run */
    settle: async (key: string) => {
      resolvers.get(key)!(key)
      await new Promise(resolve => {
        setTimeout(resolve, 0)
      })
    },
  }
}

function tick() {
  return new Promise(resolve => {
    setTimeout(resolve, 0)
  })
}

// How long a read took is a property of the transport, not of how the consumer
// is using the cache, so it says nothing about what will be wanted next. Order
// evictions by it and the cache preferentially keeps whatever was slowest to
// arrive -- in @gmod/tabix that is the largest chunk of the query, so the one
// entry a member never gives up becomes its biggest, and a budget smaller than
// that chunk is one it can never get back under. Measured at 3.2MB retained
// against a 2MB budget.
test('a slow read does not outrank one that was asked for earlier', async () => {
  const budget = new SharedBudget(Infinity)
  const { cache, settle } = parked(budget, 100)
  cache.maxSize = 200

  void cache.get('asked-first')
  void cache.get('asked-second')
  await tick()
  // the slower read is the one asked for first, so it settles last
  await settle('asked-second')
  await settle('asked-first')

  void cache.get('trigger')
  await settle('trigger')

  expect(cache.has('asked-first')).toBe(false)
  expect(cache.has('asked-second')).toBe(true)
  expect(cache.has('trigger')).toBe(true)
})

// lruSpare() takes a cacheKey from map order and reports *its* seq, and the
// budget picks a victim by comparing those seqs across members. That only works
// while the two orders agree. Settling used to stamp a fresh seq without moving
// the entry, so a cache whose reads settled out of the order they were started
// in handed the budget a seq belonging to some other entry -- and the budget
// evicted a member that was not holding the oldest thing in the system.
test('the budget compares seqs that describe the entries offered', async () => {
  const budget = new SharedBudget(400)
  const one = parked(budget, 100)
  const two = parked(budget, 100)

  // asked for in this order, so `x` is the oldest thing in the system
  void one.cache.get('x')
  void one.cache.get('x2')
  void two.cache.get('p')
  void two.cache.get('p2')
  await tick()

  // but cache two's reads come back first
  await two.settle('p')
  await two.settle('p2')
  await one.settle('x')
  await one.settle('x2')

  void two.cache.get('trigger')
  await two.settle('trigger')

  expect(one.cache.has('x')).toBe(false)
  expect(one.cache.has('x2')).toBe(true)
  expect(two.cache.has('p')).toBe(true)
  expect(two.cache.has('p2')).toBe(true)
})

// The recency counter the budget picks its victim by has to be one counter, and
// a module-level one is not. This package ships an ESM build and a CJS build, so
// a consumer whose dependency graph reaches both loads the module twice and gets
// two counters, each starting at zero -- members from the two then offer this
// budget colliding stamps and the order it evicts by means nothing.
//
// resetModules is how that duplication is reproducible here: the second import
// re-evaluates the module, which is exactly what a second copy in a bundle is.
// Owning the counter puts it on the budget instead, and a shared budget is by
// definition one object however many copies of the class exist.
test('one budget orders its members even when the package is loaded twice', async () => {
  const first = await import('../src/index.ts')
  vi.resetModules()
  const second = await import('../src/index.ts')
  expect(second.SharedReadCache).not.toBe(first.SharedReadCache)

  const budget = new first.SharedBudget(6)
  const make = (m: typeof first) =>
    new m.SharedReadCache<string, string>({
      budget,
      sizeOf: () => 1,
      fill: key => Promise.resolve(key),
    })
  // registered first, so it loses any tie and a stale order shows up as a win
  const a = make(first)
  const b = make(second)

  for (const key of ['b1', 'b2', 'b3', 'b4', 'b5']) {
    await b.get(key)
  }
  // read last, so these two are the most recently used of all seven
  await a.get('a1')
  await a.get('a2')

  expect(b.has('b1')).toBe(false)
  expect(a.has('a1')).toBe(true)
  expect(a.has('a2')).toBe(true)
})

test('a cache with no budget has no cross-cache order to keep', async () => {
  const budget = new SharedBudget(10)
  const unbudgeted = new SharedReadCache<string, string>({
    sizeOf: () => 1,
    fill: key => Promise.resolve(key),
  })
  const member = weighed(budget, 1)

  await unbudgeted.get('x')
  await member.get('a')
  await member.get('b')

  // the unbudgeted cache draws no stamps, so the budget's order is unbroken by
  // a cache it does not hold
  expect(budget.total).toBe(2)
  expect(unbudgeted.totalSize).toBe(1)
})

/**
 * A collection is a request, not an instruction, so this asks repeatedly and
 * yields in between: a WeakRef is not cleared until the collector has both run
 * and finished with the object.
 */
async function collect() {
  for (let attempt = 0; attempt < 20; attempt++) {
    globalThis.gc?.()
    await new Promise(resolve => setTimeout(resolve, 1))
  }
}

/**
 * Only where a collection can actually be asked for. CI runs the suite with
 * `--expose-gc` so these always run there; a plain `pnpm test` skips them, and
 * `NODE_OPTIONS=--expose-gc pnpm test` opts in locally.
 */
const testWithGc = test.skipIf(globalThis.gc === undefined)

// Members are held weakly so that a long-lived budget never keeps a cache
// reachable -- closing a track in jbrowse reclaims by dropping the last
// reference to its adapter, and a budget holding its members strongly would
// turn that into the exact leak it exists to prevent. What the weak ref costs
// is that a member can vanish still owing weight, so the budget keeps its last
// known contribution beside it and credits that back once the ref is empty.
testWithGc(
  'a collected member is pruned, and stops being counted',
  async () => {
    // room to spare, so nothing is evicted and the whole 200 is still owed
    const budget = new SharedBudget(1000)

    // scoped, so nothing here holds the cache once it returns
    await (async () => {
      const cache = weighed(budget, 100)
      await cache.get('a')
      await cache.get('b')
    })()

    expect(budget.total).toBe(200)
    expect(budget.size).toBe(1)

    await collect()

    // read before size(), which would prune first and hide a stale total
    expect(budget.total).toBe(0)
    expect(budget.size).toBe(0)
  },
)

// A budget under its limit has no reason to evict, and evicting was what used
// to prune. So the one case where a stale total could sit forever is exactly
// the quiet one a consumer would poll to report memory.
testWithGc(
  'an idle budget does not go on counting a cache that is gone',
  async () => {
    const budget = new SharedBudget(Infinity)

    await (async () => {
      const cache = weighed(budget, 5)
      await cache.get('a')
    })()

    await collect()

    expect(budget.total).toBe(0)
  },
)
