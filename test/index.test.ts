import { expect, test } from 'vitest'

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
