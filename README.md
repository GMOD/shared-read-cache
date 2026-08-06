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
  maxSize: 100 * 2 ** 20,
  sizeOf: chunk => chunk.byteLength,
  cacheKey: chunk => chunk.toString(),
  fill: (chunk, signal) => readChunk(chunk, { signal }),
})

const data = await cache.get(chunk, opts.signal)
```

## `sizeOf` is the point

This package exists because four gmod packages each hand-rolled the same cache,
identical except for how they weighed an entry: `@gmod/bam` and `@gmod/tabix`
weigh decompressed bytes, `@gmod/bbi` weighs entries, `@gmod/cram` weighs
decoded records. A value cannot be weighed until its read settles, so a cache
that budgets this way has to own its entries — which is why a plain-LRU-backed
package could not serve them and each wrote its own.

Omit `sizeOf` and the budget is an entry count.

## Behaviour worth knowing

- **A caller with no signal pins the read.** It cannot give up, so no set of
  aborts should stop the read it joined. One signal-free consumer therefore
  makes that read uncancellable for everyone joined to it.
- **A rejection is dropped, not cached**, so one transient failure does not
  poison the key for the life of the cache.
- **The last settled entry survives any budget.** A value larger than the whole
  budget is still worth holding; dropping it only buys an immediate re-read.
- **Reads in flight are never evicted.** They are not results yet, and dropping
  one loses the de-duplication its callers are relying on.

## Relationship to `@gmod/abortable-promise-cache`

This replaces it. Two things that package got wrong are fixed here:

- it never took a listener back off a caller's signal, so a long-lived signal
  accumulated one per key it ever touched
- a caller that arrived already aborted was registered as a waiter, and an abort
  listener never fires on an already-aborted signal — so the count could never
  reach zero and the read became uncancellable for everyone joined to it
