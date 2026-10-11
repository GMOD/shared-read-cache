# @gmod/shared-read-cache

A promise cache for reads that several callers want at once. One read per key,
shared by everyone who asks for it while it is in flight, cancelled only once
**every** one of them has given up.

## Why

Memoizing a bare promise built from the first caller's signal makes that
caller's abort reject everyone else awaiting it. In a genome browser, panning
away from one block then fails its still-wanted siblings.

```js
import { SharedReadCache } from '@gmod/shared-read-cache'

const cache = new SharedReadCache({
  cacheKey: chunk => chunk.toString(),
  fill: (chunk, signal) => readChunk(chunk, { signal }),
})

const data = await cache.get(chunk, opts.signal)
```

This package caches what a read produced, keyed however you like.
[`@gmod/range-cache-filehandle`](https://github.com/GMOD/range-cache-filehandle)
sits below it and caches the raw HTTP byte ranges underneath a filehandle.

## Docs

- [docs/dataflow.md](docs/dataflow.md) — how one `get()` flows, with a diagram:
  where a caller's signal is checked, what `join` does with it, and what
  settling an entry costs
- [docs/memory.md](docs/memory.md) — the four ways an entry leaves the cache,
  and what each of `maxSize`, `idleTimeoutMs` and `SharedBudget` measured
- [docs/api.md](docs/api.md) — every option and method
- [docs/consumers.md](docs/consumers.md) — which gmod package uses this for
  what, which of them can share a budget, and where each measurement above was
  taken

## Budgets are opt-in

There is no default limit, because a sensible one depends on what you cache:

```js
const cache = new SharedReadCache({
  maxSize: 100 * 2 ** 20,
  sizeOf: chunk => chunk.byteLength,
  cacheKey: chunk => chunk.toString(),
  fill: (chunk, signal) => readChunk(chunk, { signal }),
})
```

A budget bounds _retained_ memory, not request size:

- The cache never turns a value away for being too large. A value bigger than
  the whole budget still goes in.
- Eviction never touches a read in flight.
- Eviction only discards values the cache has already handed back once, so the
  worst a budget can cost is a re-read.

With no budget the cache grows for the life of the object. `@gmod/tabix`
measured 2GB RSS panning a dense VCF before it bounded this. Pass a budget if
the values are large or the object is long-lived.

Setting `cache.maxSize = n` later evicts immediately, so a consumer can shed
memory under pressure.

## `idleTimeoutMs` — reclaiming while nothing is happening

The cache checks `maxSize` when a read settles, so an idle cache stays at the
level it reached. For an object that lasts as long as its UI, such as a genome
browser parked on a region across every open track, that resting level is the
memory that matters, and no budget alone lowers it.

```js
const cache = new SharedReadCache({
  maxSize: 1024 * 2 ** 20, // the ceiling under load
  idleTimeoutMs: 180_000, // ...but only while it is being used
  sizeOf: chunk => chunk.byteLength,
  fill: (chunk, signal) => readChunk(chunk, { signal }),
})
```

Use the two options together:

- Set `maxSize` generously. Below one request's working set it caches _nothing_:
  each value falls out before the next request can reuse it, while the reads in
  flight hold their memory anyway.
- `idleTimeoutMs` makes a generous ceiling affordable, because memory peaks
  under load and falls back when idle.

How the idle clock works:

- It runs from the last **read** of an entry, or from the fill settling if
  nothing has read it since.
- An entry fetched once and used every second never expires.
- A slow read still gets the full timeout for reuse after its download ends.
- The sweep skips reads in flight.
- `cache.sweepIdle()` reclaims on demand, for example when a tab goes hidden.

The sweep timer:

- The first read to settle arms it, and the first sweep that finds no settled
  entry stops it.
- It holds its cache weakly, so a dropped cache is collected without a
  `dispose()` call.
- It calls `unref` where that exists, so it never holds a Node process open.

## One budget across several caches

A per-cache ceiling does not bound a consumer that opens many caches, such as
one per open file. `SharedBudget` bounds them in aggregate and evicts the
globally least-recently-used entry, so an idle cache hands its space to a busy
one:

```js
const budget = new SharedBudget(1024 * 2 ** 20)
const cache = new SharedReadCache({ budget, sizeOf, fill })
```

- `SharedBudget` works alongside `maxSize`; it does not replace it.
- It holds its members weakly, so there is no `unregister` to call.
- Every member must measure size in the same unit. Adding one cache's bytes to
  another's entry counts bounds neither.

[docs/memory.md](docs/memory.md) has the measurement for dividing a ceiling by
the file count instead.

## Why `sizeOf`

`sizeOf` weighs a settled value against the budget. Omit it and the budget
counts entries.

Four gmod packages hand-rolled this cache, differing only in how they weighed an
entry: `@gmod/bam` and `@gmod/tabix` weigh decompressed bytes, `@gmod/cram`
weighs bytes, and `@gmod/bbi` weighs entries. The cache can only call `sizeOf`
once a read settles, so a cache that budgets this way has to own its entries,
which a plain LRU package could not do.

## Behaviour worth knowing

- A caller with no signal pins the read. It can never abort, so aborting every
  other caller does not stop the read, and the read is uncancellable for
  everyone joined to it.
- The cache drops a rejection rather than caching it, so one transient failure
  does not poison the key for the life of the cache.
- The last settled entry survives any budget. A value larger than the whole
  budget is still worth holding; dropping it only costs an immediate re-read.
- Eviction never touches a read in flight. Dropping the promise would lose the
  de-duplication its callers rely on.

## Relationship to `@gmod/abortable-promise-cache`

This package replaces `@gmod/abortable-promise-cache`, which had two bugs:

- It never removed its listener from a caller's signal, so a long-lived signal
  accumulated one per key.
- It counted a caller that arrived already aborted as a waiter. An abort
  listener never fires on an already-aborted signal, so the count never reached
  zero and the read became uncancellable for everyone joined to it.
