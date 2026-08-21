import { expect, test } from 'vitest'

import { SharedBudget, SharedReadCache } from '../src/index.ts'

// Random operation sequences, checked after every step against the things that
// must hold whatever happened. The accounting bugs this file exists for take a
// particular sequence to reach, which is why the hand-written tests missed them.
// Seeded, so a failure is reproducible from the seed alone.

/** Deterministic PRNG (mulberry32), so a failure is reproducible from its seed. */
function rng(seed: number) {
  let state = seed
  return () => {
    state = (state + 0x6d2b79f5) | 0
    let t = Math.imul(state ^ (state >>> 15), 1 | state)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function tick() {
  return new Promise(resolve => {
    setTimeout(resolve, 0)
  })
}

const KEYS = ['a', 'b', 'c', 'd', 'e', 'f']

/** every read here is expected to fail some of the time; the state is the test */
const swallow = () => 'given up on'

/** a read that never settles, however long anyone waits */
const forever = () => new Promise<string>(() => 'never resolves')

function world(seed: number) {
  const random = rng(seed)
  const pick = <T>(xs: T[]) => xs[Math.floor(random() * xs.length)]!
  const budget = new SharedBudget(12)
  /** resolvers for reads parked mid-flight, released by the `settle` step */
  const parked: (() => void)[] = []
  const outstanding: Promise<unknown>[] = []
  const controllers: AbortController[] = []
  /** reads that neither settle nor honour their signal, as a dead socket does */
  const stalled: AbortController[] = []

  const build = (maxSize: number, evictionPolicy: 'lru' | 'batch') =>
    new SharedReadCache<string, string>({
      budget,
      maxSize,
      evictionPolicy,
      sizeOf: value => value.length,
      fill: (key, signal) =>
        new Promise<string>((resolve, reject) => {
          parked.push(() => {
            resolve(key.repeat(1 + (key.charCodeAt(0) % 3)))
          })
          signal.addEventListener('abort', () => {
            reject(new Error('aborted'))
          })
        }),
    })

  const lru = build(6, 'lru')
  const batch = build(8, 'batch')
  const caches = [lru, batch]

  const check = () => {
    for (const cache of caches) {
      expect(Number.isFinite(cache.totalSize)).toBe(true)
      expect(cache.totalSize).toBeGreaterThanOrEqual(0)
      expect(cache.size).toBeGreaterThanOrEqual(0)
    }
    // the budget is a sum over its members, so it has to equal one
    const held = caches.reduce((sum, cache) => sum + cache.totalSize, 0)
    expect(budget.total).toBe(held)
  }

  const steps: (() => void)[] = [
    () => {
      const cache = pick(caches)
      const controller = new AbortController()
      controllers.push(controller)
      outstanding.push(cache.get(pick(KEYS), controller.signal).catch(swallow))
    },
    () => {
      const cache = pick(caches)
      // signal-free, so it pins the read
      outstanding.push(cache.get(pick(KEYS)).catch(swallow))
    },
    () => {
      const controller = controllers.length > 0 ? pick(controllers) : undefined
      controller?.abort()
    },
    () => {
      const released = parked.shift()
      released?.()
    },
    () => {
      const controller = new AbortController()
      stalled.push(controller)
      // its own key space, so a signal-free caller never joins one and waits on
      // a read that by construction cannot land
      // deliberately not awaited with the rest: nothing can make one land, so
      // the end of the run gives up on it rather than waiting for it
      void pick(caches)
        .get(`stall${stalled.length}`, controller.signal, forever)
        .catch(swallow)
    },
    () => {
      pick(caches).delete(pick(KEYS))
    },
    () => {
      void pick(caches).getIfCached(pick(KEYS))
    },
    () => {
      pick(caches).has(pick(KEYS))
    },
    () => {
      const cache = pick(caches)
      cache.maxSize = 1 + Math.floor(random() * 10)
    },
    () => {
      budget.limit = 4 + Math.floor(random() * 12)
    },
    () => {
      pick(caches).sweepIdle()
    },
  ]

  return {
    budget,
    caches,
    lru,
    batch,
    parked,
    outstanding,
    stalled,
    steps,
    check,
    pick,
  }
}

test.each([1, 2, 3, 12345, 987654])(
  'the accounting holds across a random sequence (seed %i)',
  async seed => {
    const {
      budget,
      caches,
      lru,
      batch,
      parked,
      outstanding,
      stalled,
      steps,
      check,
      pick,
    } = world(seed)

    for (let step = 0; step < 250; step++) {
      pick(steps)()
      // let whatever that started settle before asking anything of the cache
      if (step % 5 === 0) {
        await tick()
      }
      check()
    }

    // Reads in flight are exempt from every budget by design, so the ceilings
    // are only assertable once nothing is waiting on one.
    while (parked.length > 0) {
      parked.shift()?.()
    }
    // a stalled read cannot be released, only given up on
    for (const controller of stalled) {
      controller.abort()
    }
    await Promise.all(outstanding)
    await tick()
    check()

    // a hard ceiling, except that the last settled entry is kept whatever the
    // budget, so one entry left is the floor rather than a violation
    if (lru.size > 1) {
      expect(lru.totalSize).toBeLessThanOrEqual(lru.maxSize)
    }

    // Not a hard ceiling: a batch touching more than the whole budget stays over
    // it until the next batch lands. So land two -- one to end the batch still
    // marked current, one to evict it -- and it comes back under. That it always
    // can is the property worth pinning, since an abandoned read used to leave
    // the pending count nonzero forever and then no next batch could land.
    for (const key of ['y', 'z']) {
      await batch.get(key, undefined, () => Promise.resolve(key))
    }
    await tick()
    if (batch.size > 1) {
      expect(batch.totalSize).toBeLessThanOrEqual(batch.maxSize)
    }

    if (caches.every(cache => cache.size > 1)) {
      expect(budget.total).toBeLessThanOrEqual(budget.limit)
    }

    // and nothing is left owed once every member has let go
    for (const cache of caches) {
      cache.clear()
      expect(cache.size).toBe(0)
      expect(cache.totalSize).toBe(0)
    }
    expect(budget.total).toBe(0)
  },
)
