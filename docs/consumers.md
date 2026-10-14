# Who uses this, and what they weigh

Every number in [memory.md](memory.md) was measured in a consumer rather than
here — this package has no I/O of its own, so a benchmark of it in isolation
measures a `Map`. This page lists which repo each claim comes from, and answers
whether two of them can share a budget, since a budget's total is a sum over its
members and means nothing unless they weigh the same thing.

| package                                                         | what it caches                                 | `sizeOf` unit                                             | budget?            |
| --------------------------------------------------------------- | ---------------------------------------------- | --------------------------------------------------------- | ------------------ |
| [`@gmod/bam`](https://github.com/GMOD/bam-js)                   | parsed chunks, the unit the BAI hands out      | decompressed bytes                                        | `cacheBudget`      |
| [`@gmod/tabix`](https://github.com/GMOD/tabix-js)               | decompressed chunks                            | decompressed bytes                                        | `chunkCacheBudget` |
| [`@gmod/cram`](https://github.com/GMOD/cram-js)                 | decoded slices                                 | decoded bytes                                             | `cacheBudget`      |
| [`@gmod/bbi`](https://github.com/GMOD/bbi-js)                   | headers, R-tree nodes, BigBed indices          | **entries** (1000, and 1 for each memo)                   | no                 |
| [`@gmod/nclist`](https://github.com/GMOD/nclist-js)             | chunks, lazy-array pages, data roots           | **entries** (`cacheSize`, default 100; 10 for data roots) | no                 |
| [`@gmod/hic`](https://github.com/GMOD/hic)                      | matrices, norm vectors, header and index memos | **entries** (512 and 64)                                  | no                 |
| [`@gmod/indexedfasta`](https://github.com/GMOD/indexedfasta-js) | the parsed `.fai`                              | unbounded, one entry                                      | no                 |

bam, tabix and cram can share one budget, because all three weigh decompressed
bytes, and a genome browser's memory problem is the sum across formats rather
than any one of them. jbrowse puts all three on one budget. bbi, nclist and hic
weigh entries, so those cannot join a byte budget. The cache cannot detect that
mismatch at runtime, because `sizeOf` is opaque by design.

bbi, nclist, hic and indexedfasta use the cache mostly for its de-duplication:
one read per key, shared by every caller, with an abort that does not reject the
others. Their `maxSize` is an entry count that is easy to set because the values
are small and few. indexedfasta, the degenerate case and a real one, uses the
package as a memo: `new SharedReadCache({})`, one entry, never evicted, with the
fill passed per `get()` call.

## Where the measurements live

- **The 2 GB unbounded VCF, and the cliff below one query's working set** —
  [tabix-js/docs/caching.md](https://github.com/GMOD/tabix-js/blob/main/docs/caching.md).
  Also the unit change in v3.5.2 that turned a pinned `chunkCacheSize` into a
  total miss, a concrete case of a budget below the working set costing
  everything and saving nothing.
- **The idle sweep, and 331 MB going to 0 MB** —
  [bam-js/docs/caching.md](https://github.com/GMOD/bam-js/blob/main/docs/caching.md)
  and
  [ADR 0015](https://github.com/GMOD/bam-js/blob/main/agent-docs/architecture-decision-records/0015-reclaim-the-chunk-cache-when-nothing-is-using-it.md).
- **Why a per-file ceiling bounds nothing, and what an equal split cost** —
  [bam-js ADR 0018](https://github.com/GMOD/bam-js/blob/main/agent-docs/architecture-decision-records/0018-a-per-file-ceiling-is-not-a-bound-on-a-consumer-with-many-files.md),
  the ADR that led to `SharedBudget`.
- **Why the batch eviction policy is gone** — cram-js adopted it and then
  dropped it
  ([ADR 0005](https://github.com/GMOD/cram-js/blob/main/docs/adr/0005-drop-the-batch-eviction-policy.md),
  and
  [docs/memory.md](https://github.com/GMOD/cram-js/blob/main/docs/memory.md#the-slice-cache)
  for the slice cache it bounded); bam-js measured that it did not transfer
  ([ADR 0013](https://github.com/GMOD/bam-js/blob/main/agent-docs/architecture-decision-records/0013-the-batch-eviction-policy-does-not-transfer.md)).
  With no consumer left, 2.0 removed the option.
- **What a budget does _not_ bound** — the "none of them bound peak memory"
  sections of both caching docs. Reads in flight, the query's own hold on what
  it parsed, and fields memoized onto a record after it was weighed (bam
  measured +38% over the weighed size) are all outside any budget here.

## Reading their docs against this one

A consumer's option names are its own: `maxCacheBytes`, `chunkCacheSize` and
`cacheSize` are all `maxSize`, and `cacheIdleTimeoutMs`,
`chunkCacheIdleTimeoutMs` and `cacheIdleTimeoutMs` are all `idleTimeoutMs`. The
budget is the exception, because consumers pass a `SharedBudget` through
unchanged, so a bam file, a cram file and a tabix file can join the same one.
