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
  expect(captured).toHaveLength(1)

  const teardown = captured[0]?.signal
  expect(teardown).toBeDefined()
  expect(teardown?.aborted).toBe(false)

  release()
  await p
  expect(teardown?.aborted).toBe(true)
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
