# Who uses this, and what they weigh

Every number in [memory.md](memory.md) was measured in a consumer rather than
here — this package has no I/O of its own, so a benchmark of it in isolation
measures a `Map`. This page says which repo each claim comes from, and it is
also the answer to "can these two share a budget", since a budget's total is a
sum over its members and means nothing unless they weigh the same thing.

| package                                                         | what it caches                            | `sizeOf` unit                           | budget?            |
| --------------------------------------------------------------- | ----------------------------------------- | --------------------------------------- | ------------------ |
| [`@gmod/bam`](https://github.com/GMOD/bam-js)                   | parsed chunks, the unit the BAI hands out | decompressed bytes                      | `cacheBudget`      |
| [`@gmod/tabix`](https://github.com/GMOD/tabix-js)               | decompressed chunks                       | decompressed bytes                      | `chunkCacheBudget` |
| [`@gmod/cram`](https://github.com/GMOD/cram-js)                 | decoded slices                            | **records**                             | `cacheBudget`      |
| [`@gmod/bbi`](https://github.com/GMOD/bbi-js)                   | headers, R-tree nodes, BigBed indices     | **entries** (1000, and 1 for each memo) | no                 |
| [`@gmod/nclist`](https://github.com/GMOD/nclist-js)             | chunks, lazy-array pages, data roots      | **entries** (`cacheSize`, default 100)  | no                 |
| [`@gmod/indexedfasta`](https://github.com/GMOD/indexedfasta-js) | the parsed `.fai`                         | unbounded, one entry                    | no                 |

**bam and tabix pool cleanly** — both weigh decompressed bytes, which is the
point, since a genome browser's memory problem is the sum across formats rather
than any one of them. cram weighs decoded records, and bbi and nclist weigh
entries, so each of those wants a budget of its own. Nothing here can check
that; `sizeOf` is opaque by design.

The bottom three want the cache mostly for its de-duplication — one read per
key, shared by every caller, and an abort that does not reject the others — and
their `maxSize` is an entry count that costs nothing to state because the values
are small and few. indexedfasta's is the degenerate case and a real shape:
`new SharedReadCache({})`, one entry, never evicted, with the fill passed per
`get()` call. That is what a memo looks like here.

## Where the measurements live

- **The 2 GB unbounded VCF, and the cliff below one query's working set** —
  [tabix-js/docs/caching.md](https://github.com/GMOD/tabix-js/blob/main/docs/caching.md).
  Also the unit change in v3.5.2 that silently turned a pinned `chunkCacheSize`
  into a total miss, which is the most concrete case anywhere of a budget below
  the working set costing everything and saving nothing.
- **The idle sweep, and 331 MB going to 0 MB** —
  [bam-js/docs/caching.md](https://github.com/GMOD/bam-js/blob/main/docs/caching.md)
  and
  [ADR 0015](https://github.com/GMOD/bam-js/blob/main/agent-docs/adr/0015-reclaim-the-chunk-cache-when-nothing-is-using-it.md).
- **Why a per-file ceiling bounds nothing, and what an equal split cost** —
  [bam-js ADR 0018](https://github.com/GMOD/bam-js/blob/main/agent-docs/adr/0018-a-per-file-ceiling-is-not-a-bound-on-a-consumer-with-many-files.md).
  That ADR is why `SharedBudget` exists.
- **Both sides of the batch policy** — cram-js adopted it and then dropped it
  ([ADR 0005](https://github.com/GMOD/cram-js/blob/main/docs/adr/0005-drop-the-batch-eviction-policy.md),
  and
  [docs/memory.md](https://github.com/GMOD/cram-js/blob/main/docs/memory.md#the-slice-cache)
  for the slice cache it bounded); bam-js measured that it did not transfer
  ([ADR 0013](https://github.com/GMOD/bam-js/blob/main/agent-docs/adr/0013-the-batch-eviction-policy-does-not-transfer.md)).
  The option is still here because the shape it is for is real, but no consumer
  currently sets it.
- **What a budget does _not_ bound** — the "none of them bound peak memory"
  sections of both caching docs. Reads in flight, the query's own hold on what
  it parsed, and fields memoized onto a record after it was weighed (bam
  measured +38% over the weighed size) all sit outside anything here.

## Reading their docs against this one

A consumer's option names are its own: `maxCacheBytes`, `chunkCacheSize` and
`cacheSize` are all `maxSize`, and `cacheIdleTimeoutMs`,
`chunkCacheIdleTimeoutMs` and `cacheIdleTimeoutMs` are all `idleTimeoutMs`. The
budget is the exception — `SharedBudget` is passed through as itself, which is
what lets a bam file and a tabix file join the same one.
