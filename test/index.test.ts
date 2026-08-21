import { expect, test, vi } from 'vitest'

import { SharedReadCache, throwIfAborted } from '../src/index.ts'

// lets queued microtasks and timers run, so a joining caller reaches the
// in-flight read before we abort the owner
function tick() {
  return new Promise(resolve => {
    setTimeout(resolve, 0)
  })
}

/**
 * A fill that parks until the test releases it, so a read shared by several
 * callers can be caught mid-flight.
 *
 * `honourAbort: false` models a transport that ignores the signal, which is
 * what `LocalFile` does: the read keeps running after its cancellation, so it
 * is still sitting in the cache when the next caller arrives.
 */
function parkedFill<V>(value: V, { honourAbort = true } = {}) {
  const stats = { calls: 0, cancelled: 0 }
  let release!: () => void
  const released = new Promise<void>(resolve => {
    release = resolve
  })
  let started!: () => void
  const firstStarted = new Promise<void>(resolve => {
    started = resolve
  })
  const fill = async (_key: unknown, signal: AbortSignal) => {
    stats.calls++
    started()
    await new Promise<void>((resolve, reject) => {
      void released.then(resolve)
      signal.addEventListener('abort', () => {
        stats.cancelled++
        if (honourAbort) {
          reject(new Error('aborted'))
        }
      })
    })
    return value
  }
  return {
    fill,
    stats,
    firstStarted,
    release: () => {
      release()
    },
  }
}

test('a waiter survives the read owner aborting', async () => {
  const { fill, stats, firstStarted, release } = parkedFill('data')
  const cache = new SharedReadCache<string, string>({ fill, maxSize: 10 })

  const owner = new AbortController()
  const waiter = new AbortController()
  const ownerP = cache.get('k', owner.signal)
  await firstStarted
  const waiterP = cache.get('k', waiter.signal)
  void Promise.allSettled([ownerP, waiterP])
  await tick()

  owner.abort()
  // the waiter has not given up, so the read it joined is not cancelled and is
  // still sitting there waiting to be let go
  release()

  await expect(ownerP).rejects.toThrow(/abort/i)
  await expect(waiterP).resolves.toBe('data')
  expect(waiter.signal.aborted).toBe(false)
  expect(stats.cancelled).toBe(0)
  // one read, not two: one caller giving up is not every caller giving up
  expect(stats.calls).toBe(1)
})

test('a read is cancelled once every waiter has aborted', async () => {
  const { fill, stats, firstStarted } = parkedFill('data')
  const cache = new SharedReadCache<string, string>({ fill, maxSize: 10 })

  const a = new AbortController()
  const b = new AbortController()
  const aP = cache.get('k', a.signal)
  await firstStarted
  const bP = cache.get('k', b.signal)
  void Promise.allSettled([aP, bP])
  await tick()

  // nobody is left who wants these bytes, so the read is cancelled rather than
  // run to completion and thrown away. It is never released — the abort is what
  // unblocks it.
  a.abort()
  b.abort()
  await tick()
  expect(stats.cancelled).toBe(1)

  await expect(aP).rejects.toThrow(/abort/i)
  await expect(bP).rejects.toThrow(/abort/i)
})

test('a signal-free caller pins the read', async () => {
  const { fill, stats, firstStarted, release } = parkedFill('data')
  const cache = new SharedReadCache<string, string>({ fill, maxSize: 10 })

  const owner = new AbortController()
  const ownerP = cache.get('k', owner.signal)
  await firstStarted
  // cannot give up, so there is no set of aborts that should stop this read
  const pinnerP = cache.get('k')
  void Promise.allSettled([ownerP, pinnerP])
  await tick()
  owner.abort()
  await tick()

  expect(stats.cancelled).toBe(0)

  release()
  await expect(pinnerP).resolves.toBe('data')
  await expect(ownerP).rejects.toThrow(/abort/i)
})

test('a caller that arrives already aborted does not pin the read', async () => {
  const { fill, stats, firstStarted } = parkedFill('data')
  const cache = new SharedReadCache<string, string>({ fill, maxSize: 10 })

  const owner = new AbortController()
  const spent = new AbortController()
  spent.abort()

  const ownerP = cache.get('k', owner.signal)
  await firstStarted
  // Rejected up front rather than registered as a waiter. Were it registered,
  // its abort listener would never fire -- it already aborted -- so nothing
  // would take it back out of the set and the read could never be cancelled.
  await expect(cache.get('k', spent.signal)).rejects.toThrow(/abort/i)
  void ownerP.catch(() => undefined)

  owner.abort()
  await tick()
  expect(stats.cancelled).toBe(1)
  await expect(ownerP).rejects.toThrow(/abort/i)
})

test('a caller does not join a read every waiter has abandoned', async () => {
  // the read ignores its cancellation, so it is still in the cache when the
  // next caller arrives
  const { fill, stats, firstStarted, release } = parkedFill('data', {
    honourAbort: false,
  })
  const cache = new SharedReadCache<string, string>({ fill, maxSize: 10 })

  const owner = new AbortController()
  const ownerP = cache.get('k', owner.signal)
  void ownerP.catch(() => undefined)
  await firstStarted
  owner.abort()
  await tick()
  expect(stats.cancelled).toBe(1)

  // must start its own read rather than join one already doomed
  const nextP = cache.get('k')
  release()
  await expect(nextP).resolves.toBe('data')
  expect(stats.calls).toBe(2)
})

test('one signal joining twice adds only one listener', async () => {
  const { fill, firstStarted, release } = parkedFill('data')
  const cache = new SharedReadCache<string, string>({ fill, maxSize: 10 })

  const signal = new AbortController().signal
  const a = cache.get('k', signal)
  await firstStarted
  const b = cache.get('k', signal)
  await tick()

  expect(cache.waiterCount('k')).toBe(1)
  release()
  await expect(a).resolves.toBe('data')
  await expect(b).resolves.toBe('data')
})

test('an entry stops holding its callers signals once it settles', async () => {
  const { fill, firstStarted, release } = parkedFill('data')
  const cache = new SharedReadCache<string, string>({ fill, maxSize: 10 })

  const controller = new AbortController()
  const p = cache.get('k', controller.signal)
  await firstStarted
  expect(cache.waiterCount('k')).toBe(1)

  release()
  await p
  // A settled entry that kept its listeners would retain an AbortSignal, and
  // the controller behind it, for every caller that ever touched the key.
  expect(cache.waiterCount('k')).toBe(0)
})

test('a rejection is dropped rather than cached', async () => {
  let calls = 0
  const cache = new SharedReadCache<string, string>({
    maxSize: 10,
    fill: () => {
      calls++
      return calls === 1
        ? Promise.reject(new Error('boom'))
        : Promise.resolve('data')
    },
  })

  await expect(cache.get('k')).rejects.toThrow(/boom/)
  // retried rather than serving the failure for the life of the cache
  await expect(cache.get('k')).resolves.toBe('data')
  expect(calls).toBe(2)
})

test('a concurrent second caller shares one read', async () => {
  const { fill, stats, firstStarted, release } = parkedFill('data')
  const cache = new SharedReadCache<string, string>({ fill, maxSize: 10 })

  const a = cache.get('k')
  await firstStarted
  const b = cache.get('k')
  release()

  expect(await a).toBe('data')
  expect(await b).toBe('data')
  expect(stats.calls).toBe(1)
})

test('the budget counts entries when sizeOf is omitted', async () => {
  const cache = new SharedReadCache<number, number>({
    maxSize: 2,
    fill: key => Promise.resolve(key),
  })

  await cache.get(1)
  await cache.get(2)
  await cache.get(3)

  expect(cache.size).toBe(2)
  expect(cache.totalSize).toBe(2)
  // evicted from the least-recently-used end
  expect(cache.has(1)).toBe(false)
  expect(cache.has(3)).toBe(true)
})

test('sizeOf weighs entries against the budget', async () => {
  const cache = new SharedReadCache<number, Uint8Array>({
    maxSize: 100,
    sizeOf: v => v.byteLength,
    fill: key => Promise.resolve(new Uint8Array(key)),
  })

  await cache.get(60)
  await cache.get(60)

  expect(cache.totalSize).toBeLessThanOrEqual(100)
  expect(cache.size).toBe(1)
})

test('a value larger than the whole budget is still cached', async () => {
  const cache = new SharedReadCache<number, Uint8Array>({
    maxSize: 1,
    sizeOf: v => v.byteLength,
    fill: key => Promise.resolve(new Uint8Array(key)),
  })

  await cache.get(1000)
  // the caller needs it for the request in flight; dropping it would only buy
  // an immediate re-read
  expect(cache.size).toBe(1)
  expect(cache.totalSize).toBe(1000)
})

test('a hit moves the key to the most-recently-used end', async () => {
  const cache = new SharedReadCache<number, number>({
    maxSize: 2,
    fill: key => Promise.resolve(key),
  })

  await cache.get(1)
  await cache.get(2)
  await cache.get(1) // 2 is now the least recently used
  await cache.get(3)

  expect(cache.has(1)).toBe(true)
  expect(cache.has(2)).toBe(false)
})

test('lowering maxSize evicts immediately', async () => {
  const cache = new SharedReadCache<number, number>({
    maxSize: 10,
    fill: key => Promise.resolve(key),
  })
  await cache.get(1)
  await cache.get(2)
  await cache.get(3)
  expect(cache.size).toBe(3)

  // as a plain field this did nothing until the next read happened to run the
  // eviction loop, which on an idle consumer is never
  cache.maxSize = 1
  expect(cache.size).toBe(1)
})

test('a read in flight is not evicted', async () => {
  const { fill, firstStarted, release } = parkedFill('parked')
  const parked = new SharedReadCache<string, string>({ fill, maxSize: 1 })
  const slowP = parked.get('slow')
  await firstStarted

  // an in-flight read has no weight to reclaim, and dropping it would lose the
  // de-duplication its callers rely on
  expect(parked.has('slow')).toBe(true)
  release()
  await expect(slowP).resolves.toBe('parked')
})

test('cacheKey maps structured keys', async () => {
  let calls = 0
  const cache = new SharedReadCache<{ offset: number }, number>({
    maxSize: 10,
    cacheKey: k => `${k.offset}`,
    fill: k => {
      calls++
      return Promise.resolve(k.offset)
    },
  })

  await cache.get({ offset: 7 })
  // a different object with the same offset is the same entry
  await cache.get({ offset: 7 })
  expect(calls).toBe(1)
})

test('clear and delete drop entries and their weight', async () => {
  const cache = new SharedReadCache<number, Uint8Array>({
    maxSize: 1000,
    sizeOf: v => v.byteLength,
    fill: key => Promise.resolve(new Uint8Array(key)),
  })
  await cache.get(10)
  await cache.get(20)
  expect(cache.totalSize).toBe(30)

  cache.delete(10)
  expect(cache.totalSize).toBe(20)
  cache.clear()
  expect(cache.size).toBe(0)
  expect(cache.totalSize).toBe(0)
})

test('throwIfAborted works on a signal without the built-in method', () => {
  // Consumers pass duck-typed signals, and so does any browser older than
  // Safari 15.4, where throwIfAborted and reason do not exist.
  const signal = { aborted: true } as AbortSignal

  // Asserted by type, not by message: calling the missing method throws
  // "signal.throwIfAborted is not a function", whose text matches /abort/i
  // perfectly well, so a message check passes on the very bug it should catch.
  let thrown: unknown
  try {
    throwIfAborted(signal)
  } catch (e) {
    thrown = e
  }
  expect(thrown).toBeInstanceOf(DOMException)
  expect((thrown as DOMException).name).toBe('AbortError')
})

// The other half of supporting duck-typed signals: throwIfAborted has always
// handled the aborted one, but a LIVE `{ aborted: false }` reaches join(), which
// subscribed to it unconditionally. Every consumer of this package took the
// TypeError on the first read of any call passing such a signal -- @gmod/bam's
// getRecordsForRange answered `signal.addEventListener is not a function`
// instead of records -- and none of them noticed, because the aborted case is
// the one their tests model.
test('a duck-typed signal with no addEventListener still gets its read', async () => {
  const { fill, release } = parkedFill('data')
  const cache = new SharedReadCache<string, string>({ fill, maxSize: 10 })

  const signal = { aborted: false } as AbortSignal
  const p = cache.get('k', signal)
  release()
  await expect(p).resolves.toBe('data')
})

test('a duck-typed signal pins the read, and still reports its own abort', async () => {
  const { fill, stats, firstStarted, release } = parkedFill('data')
  const cache = new SharedReadCache<string, string>({ fill, maxSize: 10 })

  // an unsubscribable signal cannot be observed giving up, so it pins the read
  // exactly as a signal-free caller does
  const duck = { aborted: false }
  const owner = new AbortController()
  const ownerP = cache.get('k', owner.signal)
  await firstStarted
  const duckP = cache.get('k', duck as AbortSignal)
  void Promise.allSettled([ownerP, duckP])
  await tick()

  owner.abort()
  await tick()
  expect(stats.cancelled).toBe(0)

  // the duck flips while the read it pinned is still in flight: the read runs
  // to completion, and the caller is still told about its own cancellation
  duck.aborted = true
  release()
  await expect(ownerP).rejects.toThrow(/abort/i)
  await expect(duckP).rejects.toThrow(/abort/i)
  expect(stats.calls).toBe(1)
})

test('throwIfAborted throws the reason verbatim', () => {
  const controller = new AbortController()
  controller.abort('too slow')
  // spec-faithful: reason is whatever the caller passed to abort(), and
  // coercing it to an Error would hide that from a consumer who set it
  expect(() => {
    throwIfAborted(controller.signal)
  }).toThrow('too slow')
})

test('throwIfAborted passes a live or absent signal', () => {
  expect(() => {
    throwIfAborted(undefined)
  }).not.toThrow()
  expect(() => {
    throwIfAborted(new AbortController().signal)
  }).not.toThrow()
})

// The leak this package exists partly to fix has no black-box observable: a
// listener left attached to a caller's signal changes no answer the cache
// gives, it only retains the closure -- and through it the entry and its value
// -- for as long as that signal lives. @gmod/abortable-promise-cache leaked one
// per key a signal ever touched and nothing noticed.
//
// So this checks the mechanism rather than an effect: the listener must be
// registered with a teardown signal, and that teardown must fire when the entry
// settles. Without it, `waiterCount` still reads 0 (the Set is cleared either
// way) and every other test here passes.
test('the abort listener is torn down when the entry settles', async () => {
  const { fill, firstStarted, release } = parkedFill('data')
  const cache = new SharedReadCache<string, string>({ fill, maxSize: 10 })

  const controller = new AbortController()
  const captured: (AddEventListenerOptions | undefined)[] = []
  const signal = new Proxy(controller.signal, {
    get(target, prop) {
      if (prop === 'addEventListener') {
        return (
          type: string,
          listener: EventListener,
          options?: AddEventListenerOptions,
        ) => {
          captured.push(options)
          target.addEventListener(type, listener, options)
        }
      }
      const value: unknown = Reflect.get(target, prop, target)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })

  const p = cache.get('k', signal)
  await firstStarted
  // Every listener a read puts on a caller's signal, not a count of them: get()
  // registers one to track the waiter and one to release this caller early if
  // it aborts, and the invariant is about each of them carrying a teardown --
  // pinning the count here just breaks the next time a second one is needed.
  expect(captured.length).toBeGreaterThan(0)

  const teardowns = captured.map(options => options?.signal)
  expect(teardowns.every(signal => signal !== undefined)).toBe(true)
  expect(teardowns.some(signal => signal?.aborted)).toBe(false)

  release()
  await p
  expect(teardowns.every(signal => signal?.aborted)).toBe(true)
})

// The batch policy exists for a request that starts many reads at once and
// holds every value until it returns -- evicting one mid-request frees nothing,
// because the caller still has it, but it does guarantee the next identical
// request re-reads it. @gmod/cram measured 117ms against 12ms for exactly this.
test('the batch policy keeps every entry of one over-budget batch', async () => {
  const cache = new SharedReadCache<number, number[]>({
    maxSize: 2,
    sizeOf: v => v.length,
    evictionPolicy: 'batch',
    fill: key => Promise.resolve([key, key]),
  })

  // two entries of 2 against a budget of 2, started together
  await Promise.all([cache.get(1), cache.get(2)])

  expect(cache.size).toBe(2)
  expect(cache.totalSize).toBe(4)
})

test('the batch policy evicts the previous batch once a new one lands', async () => {
  const cache = new SharedReadCache<number, number[]>({
    maxSize: 2,
    sizeOf: v => v.length,
    evictionPolicy: 'batch',
    fill: key => Promise.resolve([key, key]),
  })

  await Promise.all([cache.get(1), cache.get(2)])
  // a later batch does not spare what the earlier one touched
  await cache.get(3)

  expect(cache.has(3)).toBe(true)
  expect(cache.size).toBe(1)
})

// evict() returns early when the cache is under its budget, which is why that
// guard sits BELOW the batch branch rather than at the top: the batch branch
// clears its touched marks unconditionally, and those marks are how it tells
// the batch in flight from the previous one. Hoist the guard above it and
// under-budget batches never get cleared, so everything reads as touched and
// the first over-budget batch spares the whole cache instead of evicting.
test('the batch policy still clears its marks while under budget', async () => {
  const cache = new SharedReadCache<string, number>({
    maxSize: 2,
    sizeOf: () => 1,
    evictionPolicy: 'batch',
    fill: () => Promise.resolve(1),
  })

  // two batches that never reach the budget, so eviction never runs
  await cache.get('a')
  await cache.get('b')
  expect(cache.size).toBe(2)

  // the batch that tips it over: 'a' and 'b' belong to previous batches and
  // must be evictable, so the oldest goes and the budget is held
  await cache.get('c')
  expect(cache.totalSize).toBe(2)
  expect(cache.has('a')).toBe(false)
  expect(cache.has('b')).toBe(true)
  expect(cache.has('c')).toBe(true)
})

test('the lru policy holds the budget as a hard ceiling', async () => {
  const cache = new SharedReadCache<number, number[]>({
    maxSize: 2,
    sizeOf: v => v.length,
    fill: key => Promise.resolve([key, key]),
  })

  // the same over-budget batch the batch policy keeps whole
  await Promise.all([cache.get(1), cache.get(2)])

  // default policy, so the budget is a memory guarantee and one has to go
  expect(cache.size).toBe(1)
  expect(cache.totalSize).toBe(2)
})

test('a fill can be passed per call rather than per cache', async () => {
  // for a read that is a closure over the thing being read rather than a
  // function of the key, which is how @gmod/cram decodes a slice
  const cache = new SharedReadCache<string, string>({ maxSize: 10 })

  const a = await cache.get('k', undefined, () => Promise.resolve('first'))
  // second call hits the cache, so its fill is never run
  const b = await cache.get('k', undefined, () => Promise.resolve('second'))

  expect(a).toBe('first')
  expect(b).toBe('first')
})

test('a cache with no fill at all says so', async () => {
  const cache = new SharedReadCache<string, string>({ maxSize: 10 })
  await expect(cache.get('k')).rejects.toThrow(/needs a fill/)
})

test('getIfCached returns the shared promise, or undefined', async () => {
  const cache = new SharedReadCache<string, string>({
    maxSize: 10,
    fill: key => Promise.resolve(`v-${key}`),
  })

  expect(cache.getIfCached('a')).toBeUndefined()
  const p = cache.get('a')
  // the same shared promise, not a per-caller chain
  expect(cache.getIfCached('a')).toBe(cache.getIfCached('a'))
  expect(await cache.getIfCached('a')).toBe(await p)
})

test('getIfCached marks the entry most recently used', async () => {
  const cache = new SharedReadCache<string, string>({
    maxSize: 2,
    fill: key => Promise.resolve(key),
  })
  await cache.get('a')
  await cache.get('b')

  // a lookup, not an inspection: this is what saves 'a' from the next eviction
  void cache.getIfCached('a')
  await cache.get('c')

  expect(cache.has('a')).toBe(true)
  expect(cache.has('b')).toBe(false)
})

test('the cache is unbounded unless a budget is given', async () => {
  // the package prescribes no limit: what a sensible one is depends entirely on
  // what is being cached, so a consumer that wants a bound passes one
  const cache = new SharedReadCache<number, number[]>({
    sizeOf: v => v.length,
    fill: key => Promise.resolve(new Array<number>(key).fill(0)),
  })

  for (let i = 1; i <= 5; i++) {
    await cache.get(i * 1000)
  }

  expect(cache.maxSize).toBe(Infinity)
  expect(cache.size).toBe(5)
  expect(cache.totalSize).toBe(15000)
})

test('a budget can be imposed on a cache that started unbounded', async () => {
  const cache = new SharedReadCache<number, number>({
    fill: key => Promise.resolve(key),
  })
  await cache.get(1)
  await cache.get(2)
  await cache.get(3)
  expect(cache.size).toBe(3)

  // 1 is the most recently used despite being the oldest inserted. Recency has
  // to be tracked even while unbounded, or imposing a budget now would evict by
  // insertion order and throw away exactly the entry most likely to be wanted.
  void cache.getIfCached(1)

  cache.maxSize = 1
  expect(cache.size).toBe(1)
  expect(cache.has(1)).toBe(true)
  expect(cache.has(3)).toBe(false)
})

// --- idle timeout ---------------------------------------------------------

test('sweeps an entry nothing has read for the idle timeout', async () => {
  vi.useFakeTimers()
  try {
    const cache = new SharedReadCache<string, number>({ idleTimeoutMs: 1000 })
    await cache.get('a', undefined, () => Promise.resolve(1))
    expect(cache.size).toBe(1)

    vi.advanceTimersByTime(500)
    expect(cache.size).toBe(1)

    vi.advanceTimersByTime(1000)
    expect(cache.size).toBe(0)
  } finally {
    vi.useRealTimers()
  }
})

test('the timeout runs from the last read, not from the fill', async () => {
  vi.useFakeTimers()
  try {
    const cache = new SharedReadCache<string, number>({ idleTimeoutMs: 1000 })
    let fills = 0
    const fill = () => {
      fills++
      return Promise.resolve(1)
    }
    await cache.get('a', undefined, fill)

    // read it every 600ms — never idle for a full second, so never swept
    for (let i = 0; i < 5; i++) {
      vi.advanceTimersByTime(600)
      await cache.get('a', undefined, fill)
    }
    expect(fills).toBe(1)
    expect(cache.size).toBe(1)

    // now leave it alone
    vi.advanceTimersByTime(2000)
    expect(cache.size).toBe(0)
  } finally {
    vi.useRealTimers()
  }
})

test('never sweeps a read still in flight', async () => {
  vi.useFakeTimers()
  try {
    const cache = new SharedReadCache<string, number>({ idleTimeoutMs: 1000 })
    let release!: (v: number) => void
    const parked = new Promise<number>(resolve => {
      release = resolve
    })
    const p = cache.get('a', undefined, () => parked)

    vi.advanceTimersByTime(5000)
    // still in flight, so still there — dropping it would strand its waiters
    expect(cache.size).toBe(1)

    release(7)
    await expect(p).resolves.toBe(7)
    expect(cache.size).toBe(1)
  } finally {
    vi.useRealTimers()
  }
})

test('no idle timeout means no sweeping and no timer', async () => {
  vi.useFakeTimers()
  try {
    const cache = new SharedReadCache<string, number>({})
    await cache.get('a', undefined, () => Promise.resolve(1))
    vi.advanceTimersByTime(1_000_000)
    expect(cache.size).toBe(1)
    expect(vi.getTimerCount()).toBe(0)
  } finally {
    vi.useRealTimers()
  }
})

test('the sweep timer stops once the cache empties, and restarts after', async () => {
  vi.useFakeTimers()
  try {
    const cache = new SharedReadCache<string, number>({ idleTimeoutMs: 1000 })
    await cache.get('a', undefined, () => Promise.resolve(1))
    expect(vi.getTimerCount()).toBe(1)

    vi.advanceTimersByTime(2000)
    expect(cache.size).toBe(0)
    // an idle consumer must not be left holding a ticking timer
    expect(vi.getTimerCount()).toBe(0)

    await cache.get('b', undefined, () => Promise.resolve(2))
    expect(vi.getTimerCount()).toBe(1)
  } finally {
    vi.useRealTimers()
  }
})

test('clear() stops the sweep timer', async () => {
  vi.useFakeTimers()
  try {
    const cache = new SharedReadCache<string, number>({ idleTimeoutMs: 1000 })
    await cache.get('a', undefined, () => Promise.resolve(1))
    cache.clear()
    expect(vi.getTimerCount()).toBe(0)
  } finally {
    vi.useRealTimers()
  }
})

test('sweepIdle() reclaims on demand, without waiting for the interval', async () => {
  vi.useFakeTimers()
  try {
    const cache = new SharedReadCache<string, number>({
      idleTimeoutMs: 60_000,
    })
    await cache.get('stale', undefined, () => Promise.resolve(1))

    // move the CLOCK without running timers, so the interval has provably not
    // fired and only the manual call can be what reclaims
    vi.setSystemTime(Date.now() + 61_000)
    await cache.get('fresh', undefined, () => Promise.resolve(2))
    expect(cache.size).toBe(2)

    cache.sweepIdle()
    expect(cache.size).toBe(1)
    expect(cache.has('stale')).toBe(false)
    expect(cache.has('fresh')).toBe(true)
  } finally {
    vi.useRealTimers()
  }
})

test('idle sweeping composes with a size budget', async () => {
  vi.useFakeTimers()
  try {
    const cache = new SharedReadCache<string, number>({
      maxSize: 10,
      sizeOf: () => 4,
      idleTimeoutMs: 1000,
    })
    await cache.get('a', undefined, () => Promise.resolve(1))
    await cache.get('b', undefined, () => Promise.resolve(2))
    expect(cache.totalSize).toBe(8)

    vi.advanceTimersByTime(2000)
    expect(cache.size).toBe(0)
    // the budget's bookkeeping has to come back to zero with the entries
    expect(cache.totalSize).toBe(0)
  } finally {
    vi.useRealTimers()
  }
})

// The clock cannot start before the value exists. Stamped when the READ began,
// an entry lost its fill duration out of its idle budget, and one whose fill
// outran the timeout landed already expired — swept on the next tick, so the
// query that paid for that read never got one hit off it.
test('a fill slower than the timeout still gets the full timeout', async () => {
  vi.useFakeTimers()
  try {
    const cache = new SharedReadCache<string, number>({ idleTimeoutMs: 1000 })
    const p = cache.get(
      'a',
      undefined,
      () =>
        new Promise<number>(resolve => {
          setTimeout(() => {
            resolve(1)
          }, 4000)
        }),
    )
    await vi.advanceTimersByTimeAsync(4000)
    await expect(p).resolves.toBe(1)

    // 900ms of genuine idleness against a 1000ms timeout: still cached, even
    // though the read began 4900ms ago
    await vi.advanceTimersByTimeAsync(900)
    expect(cache.size).toBe(1)

    await vi.advanceTimersByTimeAsync(1100)
    expect(cache.size).toBe(0)
  } finally {
    vi.useRealTimers()
  }
})

// The sweep timer roots this cache, and this cache roots whatever its fill
// closes over. A read that never settles is never swept, so keying the stop on
// an empty map let one stalled fetch tick forever and pin that whole graph —
// precisely when a consumer has given up and dropped the cache.
test('a read that never settles does not keep the sweep timer alive', async () => {
  vi.useFakeTimers()
  try {
    const cache = new SharedReadCache<string, number>({ idleTimeoutMs: 1000 })
    // parked and never released, like a stalled fetch on a dead connection
    let release!: (v: number) => void
    const stalled = new Promise<number>(resolve => {
      release = resolve
    })
    expect(release).toBeTypeOf('function')
    void cache.get('hung', undefined, () => stalled)
    await cache.get('normal', undefined, () => Promise.resolve(1))
    expect(vi.getTimerCount()).toBe(1)

    await vi.advanceTimersByTimeAsync(2000)
    // the settled entry is reclaimed, the hung one is correctly left alone —
    // but nothing sweepable remains, so the timer must go
    expect(cache.has('normal')).toBe(false)
    expect(cache.has('hung')).toBe(true)
    expect(vi.getTimerCount()).toBe(0)
  } finally {
    vi.useRealTimers()
  }
})

// In-flight reads are skipped by the sweep, so arming it for one buys nothing
// and costs a consumer a ticking timer for the whole of a slow read.
test('an in-flight read alone arms no sweep timer', async () => {
  vi.useFakeTimers()
  try {
    const cache = new SharedReadCache<string, number>({ idleTimeoutMs: 1000 })
    let release!: (v: number) => void
    const p = cache.get(
      'a',
      undefined,
      () =>
        new Promise<number>(resolve => {
          release = resolve
        }),
    )
    expect(cache.size).toBe(1)
    expect(vi.getTimerCount()).toBe(0)

    release(7)
    await expect(p).resolves.toBe(7)
    // now there is something to reclaim
    expect(vi.getTimerCount()).toBe(1)
  } finally {
    vi.useRealTimers()
  }
})

// The timer is armed when a read SETTLES, so a read still in flight when the
// consumer clears the cache would re-arm it on landing — undoing the clear, and
// leaving a timer on a cache the consumer has finished with. The settle path is
// guarded on the entry still being the live one for its key, which is what
// stops that.
test('a read landing after clear() does not re-arm the sweep', async () => {
  vi.useFakeTimers()
  try {
    const cache = new SharedReadCache<string, number>({ idleTimeoutMs: 1000 })
    let release!: (v: number) => void
    const parked = new Promise<number>(resolve => {
      release = resolve
    })
    const p = cache.get('a', undefined, () => parked)
    cache.clear()

    release(1)
    // the caller that asked for it is still answered — clear() drops the cache,
    // not the read someone is waiting on
    await expect(p).resolves.toBe(1)
    expect(cache.size).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
  } finally {
    vi.useRealTimers()
  }
})

// The other half of the hung-read case: stopping the sweep must not be
// permanent. A read parked long enough for the sweep to stop still has to be
// reclaimable once it finally lands.
test('a sweep stopped with a read in flight restarts when it settles', async () => {
  vi.useFakeTimers()
  try {
    const cache = new SharedReadCache<string, number>({ idleTimeoutMs: 1000 })
    let release!: (v: number) => void
    const parked = new Promise<number>(resolve => {
      release = resolve
    })
    const hung = cache.get('hung', undefined, () => parked)
    await cache.get('normal', undefined, () => Promise.resolve(1))

    await vi.advanceTimersByTimeAsync(2000)
    expect(vi.getTimerCount()).toBe(0)
    expect(cache.has('hung')).toBe(true)

    release(7)
    await expect(hung).resolves.toBe(7)
    // now there is something to reclaim again
    expect(vi.getTimerCount()).toBe(1)

    // and it is reclaimed on the ordinary schedule, timed from when it landed
    await vi.advanceTimersByTimeAsync(2000)
    expect(cache.size).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
  } finally {
    vi.useRealTimers()
  }
})

// A rejection caches nothing, so there is nothing for a sweep to reclaim and no
// reason for a failing consumer to be left holding a timer.
test('a read that rejects arms no sweep timer', async () => {
  vi.useFakeTimers()
  try {
    const cache = new SharedReadCache<string, number>({ idleTimeoutMs: 1000 })
    await expect(
      cache.get('a', undefined, () => Promise.reject(new Error('boom'))),
    ).rejects.toThrow('boom')

    expect(cache.size).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
  } finally {
    vi.useRealTimers()
  }
})

// evict()'s early return is a short-circuit, not a policy change: a cache under
// its budget must still hold everything, and one over it must still evict to
// exactly where it did before. Both are pinned by the budget tests above.
test('a cache under its budget evicts nothing however many settle', async () => {
  const cache = new SharedReadCache<number, number>({
    maxSize: 1000,
    sizeOf: () => 1,
  })
  for (let i = 0; i < 500; i++) {
    await cache.get(i, undefined, () => Promise.resolve(i))
  }
  expect(cache.size).toBe(500)
  expect(cache.totalSize).toBe(500)
})

test('a zero or negative idle timeout means no idle eviction', async () => {
  vi.useFakeTimers()
  try {
    for (const idleTimeoutMs of [0, -1000]) {
      const cache = new SharedReadCache<string, number>({ idleTimeoutMs })
      await cache.get('a', undefined, () => Promise.resolve(1))
      vi.advanceTimersByTime(1_000_000)
      expect(cache.size).toBe(1)
      expect(vi.getTimerCount()).toBe(0)
    }
  } finally {
    vi.useRealTimers()
  }
})

// get() already refuses to join a read every caller has abandoned, starting a
// fresh one in its place. getIfCached has no read to start, so the equivalent
// answer is that there is nothing cached -- handing back the shared promise
// gives this caller a rejection carrying some other caller's abort reason,
// which it has no way to read as anything but its own read failing.
test('getIfCached does not hand back a read every caller has abandoned', async () => {
  const { fill, firstStarted } = parkedFill('data', { honourAbort: false })
  const cache = new SharedReadCache<string, string>({ fill, maxSize: 10 })

  const owner = new AbortController()
  const p = cache.get('k', owner.signal)
  void p.catch(() => undefined)
  await firstStarted
  owner.abort()
  await tick()

  expect(cache.getIfCached('k')).toBeUndefined()
  // and it is gone, so the next reader starts over rather than finding it again
  expect(cache.has('k')).toBe(false)
})

test('a cache can be constructed with no options at all', async () => {
  // the memo shape: no budget, no sizeOf, a fill passed per call. @gmod/bam,
  // @gmod/tabix and indexedfasta-js all build one, and all wrote `({})`.
  const cache = new SharedReadCache<string, string>()

  const value = await cache.get('k', undefined, () => Promise.resolve('v'))
  expect(value).toBe('v')
  expect(cache.maxSize).toBe(Infinity)
  expect(cache.size).toBe(1)
})

// A failed read is dropped from the map before it is marked settled, so it is
// never one of the settled entries eviction counts. Mark it first and every
// rejection credits back an entry that was never counted -- the count sinks
// below the truth, eviction reads it as "nothing left to spare" and stops, and
// the budget silently stops being a budget.
test('rejections do not make the budget stop binding', async () => {
  const cache = new SharedReadCache<number, number>({
    maxSize: 3,
    fill: key =>
      key % 2 === 0 ? Promise.reject(new Error('boom')) : Promise.resolve(key),
  })

  for (let key = 0; key < 40; key++) {
    await cache.get(key).catch(() => undefined)
  }

  expect(cache.totalSize).toBe(3)
  expect(cache.size).toBe(3)
})

// A caller's abort has to be an answer, not a request. The read is shared, so
// one caller aborting deliberately does not stop it -- and awaiting the shared
// promise therefore left that caller pending until every OTHER waiter was done.
// Two callers on a slow read, one aborts, and it waits out the full read to be
// told about a cancellation it asked for itself. Panning a genome browser is
// exactly this shape: the blocks being abandoned are the ones whose siblings
// are still wanted, so the still-wanted sibling is what sets the delay.
test('an aborting caller is released while the shared read runs on', async () => {
  const { fill, firstStarted, release, stats } = parkedFill('data')
  const cache = new SharedReadCache<string, string>({ fill })

  const leaving = new AbortController()
  const staying = new AbortController()
  const abandoned = cache.get('k', leaving.signal)
  const wanted = cache.get('k', staying.signal)
  await firstStarted

  leaving.abort()
  await expect(abandoned).rejects.toThrow(/aborted/i)

  // the read it walked away from is untouched: still running, still shared
  expect(stats.cancelled).toBe(0)
  expect(cache.waiterCount('k')).toBe(1)

  release()
  await expect(wanted).resolves.toBe('data')
  expect(stats.calls).toBe(1)
})

// The same rule with nobody else waiting, against a transport that ignores its
// signal -- `LocalFile` does, and a stalled fetch on a dead connection is the
// case a consumer aborts for in the first place. There is no later settle to
// carry the rejection here, so awaiting the shared promise never released this
// caller at all.
test('an aborting caller is released even when the read never settles', async () => {
  const cache = new SharedReadCache<string, string>({
    fill: () =>
      new Promise<string>(() => {
        // a transport that neither settles nor honours its signal
      }),
  })

  const controller = new AbortController()
  const p = cache.get('k', controller.signal)
  await tick()

  controller.abort()
  await expect(p).rejects.toThrow(/aborted/i)
})

test('an aborting caller is released with its own reason', async () => {
  const { fill, firstStarted } = parkedFill('data')
  const cache = new SharedReadCache<string, string>({ fill })

  const pinning = cache.get('k')
  const controller = new AbortController()
  const p = cache.get('k', controller.signal)
  await firstStarted

  controller.abort('panned away')
  await expect(p).rejects.toBe('panned away')
  void pinning.catch(() => 'the pinned read never settles')
})

// The early release subscribes to the caller's signal, so it has to unsubscribe
// on the way out too -- the signal outlives any one read, and a listener per
// get() is the leak the entry's dispose controller exists to prevent.
test('a completed read leaves no listener on the caller signal', async () => {
  const cache = new SharedReadCache<string, string>({
    fill: key => Promise.resolve(key),
  })

  const controller = new AbortController()
  let live = 0
  const signal = new Proxy(controller.signal, {
    get(target, prop) {
      if (prop === 'addEventListener') {
        return (
          type: string,
          listener: EventListener,
          options?: AddEventListenerOptions,
        ) => {
          live++
          options?.signal?.addEventListener('abort', () => {
            live--
          })
          target.addEventListener(type, listener, options)
        }
      }
      const value: unknown = Reflect.get(target, prop, target)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })

  for (let i = 0; i < 20; i++) {
    await cache.get(`k${i}`, signal)
  }
  await tick()
  expect(live).toBe(0)
})

// A duck-typed signal cannot be subscribed to, so there is nothing to race the
// read against and the early release has to sit the call out rather than throw
// a TypeError at it -- which is the failure mode throwIfAborted exists for.
test('a duck-typed signal still gets its read while one is in flight', async () => {
  const { fill, release } = parkedFill('data')
  const cache = new SharedReadCache<string, string>({ fill })

  const signal = { aborted: false } as AbortSignal
  const p = cache.get('k', signal)
  await tick()
  release()

  await expect(p).resolves.toBe('data')
})

// sizeOf is consumer code running on consumer values, so it can throw --
// `v => v.byteLength` over a `V` that can be undefined is the obvious way. It
// used to throw inside a handler hanging off the entry's promise, rejecting
// something nothing was holding: an unhandledRejection, which Node has treated
// as fatal since v15, while the caller that triggered it watched its own read
// succeed. A value the cache cannot weigh has to fail the read instead.
test('a value sizeOf cannot weigh fails the read rather than the process', async () => {
  const unhandled = vi.fn()
  process.on('unhandledRejection', unhandled)

  const cache = new SharedReadCache<string, string | undefined>({
    maxSize: 10,
    fill: () => Promise.resolve(undefined),
    sizeOf: value => value!.length,
  })

  await expect(cache.get('a')).rejects.toThrow(TypeError)
  await tick()

  expect(unhandled).not.toHaveBeenCalled()
  process.off('unhandledRejection', unhandled)
})

test('a value sizeOf cannot weigh is not cached, and does not poison the key', async () => {
  let weighable = false
  const cache = new SharedReadCache<string, string>({
    maxSize: 10,
    fill: key => Promise.resolve(key),
    sizeOf: value => {
      if (!weighable) {
        throw new Error('unweighable')
      }
      return value.length
    },
  })

  await expect(cache.get('a')).rejects.toThrow('unweighable')
  await tick()
  // dropped exactly as a failed read is, so nothing unaccounted is retained
  expect(cache.size).toBe(0)
  expect(cache.totalSize).toBe(0)

  weighable = true
  await expect(cache.get('a')).resolves.toBe('a')
  expect(cache.totalSize).toBe(1)
})
