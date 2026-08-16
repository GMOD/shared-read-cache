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

## Budgets are opt-in

There is no default limit. What a sensible one is depends entirely on what you
are caching, so the package does not prescribe one:

```js
const cache = new SharedReadCache({
  maxSize: 100 * 2 ** 20,
  sizeOf: chunk => chunk.byteLength,
  cacheKey: chunk => chunk.toString(),
  fill: (chunk, signal) => readChunk(chunk, { signal }),
})
```

A budget bounds _retained_ memory, not request size. The cache never turns a
value away for being too large: one bigger than the whole budget still goes in,
eviction never touches a read in flight, and it only discards values it has
already handed back once — so the worst a budget can cost is a re-read.

Unbounded is the permissive default, not the safe one. With no budget the cache
grows for the life of the object; `@gmod/tabix` measured 2GB RSS panning a dense
VCF before it bounded this. Pass one if the values are large or the object is
long-lived. `cache.maxSize = n` later evicts immediately, which is how a
consumer sheds memory under pressure.

## `idleTimeoutMs` — reclaiming while nothing is happening

The cache checks `maxSize` when a read settles, so an idle one sits at whatever
level it reached and never gives it back. For an object that lives as long as
its UI — a genome browser parked on a region, times every open track — that
resting level is the memory that matters, and no budget alone will lower it.

```js
const cache = new SharedReadCache({
  maxSize: 1024 * 2 ** 20, // the ceiling under load
  idleTimeoutMs: 180_000, // ...but only while it is being used
  sizeOf: chunk => chunk.byteLength,
  fill: (chunk, signal) => readChunk(chunk, { signal }),
})
```

The two answer different questions, and they work best together. `maxSize` wants
to be **generous**: set below one request's working set it does not cache less,
it caches _nothing_ — each value falls out before the next request can reuse it,
while the ones in flight hold their memory anyway. `idleTimeoutMs` is what makes
a generous ceiling affordable, by turning it into a peak rather than a resting
level.

The clock runs from the last **read** of an entry, or from its fill settling if
nothing has read it since, so something fetched once and used every second never
expires — and a slow read still gets the full timeout to be reused in, rather
than spending it on its own download. The sweep skips reads in flight.
`cache.sweepIdle()` reclaims on demand — on a tab going hidden, say — rather
than waiting for the interval.

The sweep runs only while it has something to reclaim: the first read to settle
arms it, and the first sweep that finds no settled entry stops it, which is why
there is no `dispose()` to forget to call. It `unref`s itself where that exists,
so it will never hold a Node process open.

## `sizeOf` is the point

This package exists because four gmod packages each hand-rolled the same cache,
identical except for how they weighed an entry: `@gmod/bam` and `@gmod/tabix`
weigh decompressed bytes, `@gmod/bbi` weighs entries, `@gmod/cram` weighs
decoded records. Nothing can weigh a value until its read settles, so a cache
that budgets this way has to own its entries — which is why a plain-LRU-backed
package could not serve them and each wrote its own.

Omit `sizeOf` and the budget counts entries.

## Behaviour worth knowing

- **A caller with no signal pins the read.** It cannot give up, so no set of
  aborts should stop the read it joined. One signal-free consumer therefore
  makes that read uncancellable for everyone joined to it.
- **A rejection drops rather than caching**, so one transient failure does not
  poison the key for the life of the cache.
- **The last settled entry survives any budget.** A value larger than the whole
  budget is still worth holding; dropping it only buys an immediate re-read.
- **Eviction never touches a read in flight.** It is not a result yet, and
  dropping one loses the de-duplication its callers are relying on.

## Relationship to `@gmod/abortable-promise-cache`

`@gmod/abortable-promise-cache` was this module's earlier inspiration. This
replaces it, and fixes two things that package got wrong:

- it never took a listener back off a caller's signal, so a long-lived signal
  accumulated one per key it ever touched
- it registered a caller that arrived already aborted as a waiter, and an abort
  listener never fires on an already-aborted signal — so the count could never
  reach zero and the read turned uncancellable for everyone joined to it
