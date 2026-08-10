import { expect, test } from 'vitest'

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
