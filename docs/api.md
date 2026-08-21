# API

```js
import {
  SharedBudget,
  SharedReadCache,
  throwIfAborted,
} from '@gmod/shared-read-cache'
```

`SharedReadCache<K, V>` is generic over the key you hand it and the value your
read returns. `cacheKey` maps the first to a string; `sizeOf` weighs the second.

## `new SharedReadCache(options?)`

Every option is optional, and so is the object — `new SharedReadCache({})` is a
real and common shape, the memo whose fill is a closure passed per `get()` call.

| option              | default       | what it does                                                                                                                                                                                                                                                                                                                     |
| ------------------- | ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `fill(key, signal)` | none          | Performs the read, under the **shared** signal — it fires only once every caller waiting on this key has aborted, never one caller's own. Either this or a per-call `fill` must be present.                                                                                                                                      |
| `cacheKey(key)`     | `String(key)` | Maps a key to its cache key.                                                                                                                                                                                                                                                                                                     |
| `sizeOf(value)`     | `() => 1`     | Weighs a settled value against the budget. The default makes the budget an entry count. Throwing fails that read for its callers and caches nothing, since a value the cache cannot weigh is one it cannot bound. See [memory.md](memory.md#sizeof-is-the-point), and [consumers.md](consumers.md) for what each package weighs. |
| `maxSize`           | `Infinity`    | Budget, in whatever unit `sizeOf` returns.                                                                                                                                                                                                                                                                                       |
| `idleTimeoutMs`     | none          | Drop an entry once nothing has asked for it for this long.                                                                                                                                                                                                                                                                       |
| `evictionPolicy`    | `'lru'`       | `'lru'` evicts as each read settles; `'batch'` waits until no reads are in flight and spares everything that batch touched. [Try a bigger `maxSize` first.](memory.md#evictionpolicy-batch--try-a-bigger-maxsize-first)                                                                                                          |
| `budget`            | none          | A [`SharedBudget`](#new-sharedbudgetlimit) this cache joins. Composes with `maxSize` rather than replacing it.                                                                                                                                                                                                                   |

### `get(key, signal?, fill?)`

The value for `key`, reading it if nothing has. Callers arriving while the read
is in flight join it rather than starting a second one, and each is told about
its own cancellation alone. Rejects immediately if `signal` has already aborted,
and as soon as it aborts while the read is in flight — the read itself runs on
for whoever still wants it. See [dataflow.md](dataflow.md).

`fill` overrides the constructor's for this call, for a read that is a closure
over the thing being read rather than a function of the key. A rejection is
dropped rather than cached, so the next caller starts over.

### `getIfCached(key)`

The promise under `key`, or `undefined` if there is none. Marks the entry
most-recently-used exactly as `get()` does: this is a lookup that happens not to
start a read, not an inspection.

The promise is the shared one, so awaiting it neither registers the caller as a
waiter nor re-reports the rejection per caller. `undefined` too for a read every
caller has already abandoned, which is not a cached value but a rejection that
has not landed yet.

### `has(key)`

Whether an entry exists, including a read still in flight. The only lookup that
does not touch LRU order.

### `delete(key)` / `clear()`

Drop one entry, or all of them, crediting the weight back to the budget.
`clear()` also stops the idle sweep.

### `sweepIdle()`

Reclaim everything idle for longer than `idleTimeoutMs` now, rather than on the
interval — on a browser tab going hidden, say. A no-op with no idle timeout
configured. Reads in flight are skipped.

### `size` / `totalSize` / `maxSize`

`size` counts entries, including reads in flight. `totalSize` sums `sizeOf` over
the settled ones. `maxSize` is settable, and lowering it evicts immediately
rather than waiting for the next read.

### `waiterCount(key)`

How many caller signals the entry is still holding. Exposed for tests: an entry
that has leaked a thousand stale signals answers every read exactly like one
that has not, so nothing else would notice.

## `new SharedBudget(limit)`

One budget shared by several caches, evicted globally least-recently-used across
all of them. Members are held weakly, and every member must weigh in the same
unit — see
[memory.md](memory.md#sharedbudget--when-the-cache-count-is-a-property-of-the-workload).

```js
const budget = new SharedBudget(1024 * 2 ** 20)
const cache = new SharedReadCache({ budget, sizeOf: v => v.byteLength, fill })
```

- **`limit`** — settable; lowering it evicts immediately.
- **`total`** — settled weight held across every live member.
- **`size`** — members still alive. Exposed for tests.
- **`evict()`** — evict until back under the limit, or until no member will give
  up another. Called for you when a member settles a read.
- **`register(member)`** / **`charge(membership, delta)`** — how a
  `BudgetMember` enrols and reports its weight. `SharedReadCache` does this in
  its constructor; there is no reason for a consumer to call either.

## `throwIfAborted(signal?)`

Throws `signal.reason` if the signal has aborted, and a `DOMException` named
`AbortError` if there is no reason. Exported because the cache uses it and
consumers doing the same check want the same semantics.

Not `signal.throwIfAborted()`, for two reasons. It assumes a _real_
`AbortSignal`, and consumers hand-roll duck-typed ones — a missing method there
is a `TypeError` rather than the cancellation the caller asked for, which is a
strictly worse failure. And it sets a browser floor of March 2022 (Safari 15.4 /
Chrome 100 / Firefox 97) that consumers of this package otherwise do not need:
they touch only `.aborted`.

## `BudgetMember`

What a `SharedBudget` needs from a cache: `lruSpare()` and `release(cacheKey)`.
`SharedReadCache` implements it. Exported as a type for anyone reading the
budget's signature, not as an extension point.
