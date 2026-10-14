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

Every option is optional, and so is the object. `new SharedReadCache({})` is
common, as a memo whose fill is a closure passed per `get()` call.

The package exports the type of the options object as
`SharedReadCacheOptions<K, V>`.

| option              | default       | what it does                                                                                                                                                                                                                                                                                                                                      |
| ------------------- | ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `fill(key, signal)` | none          | Performs the read under the **shared** signal rather than any one caller's. The shared signal aborts only once every caller waiting on this key has aborted. Either this or a per-call `fill` must be present.                                                                                                                                    |
| `cacheKey(key)`     | `String(key)` | Maps a key to its cache key.                                                                                                                                                                                                                                                                                                                      |
| `sizeOf(value)`     | `() => 1`     | Weighs a settled value against the budget. The default makes the budget an entry count. A value it cannot weigh — a throw, `NaN`, a negative — is served to the caller as normal but not cached, since the budget could not account for it. See [memory.md](memory.md#why-sizeof), and [consumers.md](consumers.md) for what each package weighs. |
| `maxSize`           | `Infinity`    | Budget, in whatever unit `sizeOf` returns.                                                                                                                                                                                                                                                                                                        |
| `idleTimeoutMs`     | none          | Drop an entry once nothing has asked for it for this long. `0`, a negative and `Infinity` all mean never.                                                                                                                                                                                                                                         |
| `budget`            | none          | A [`SharedBudget`](#new-sharedbudgetlimit) this cache joins. Composes with `maxSize` rather than replacing it.                                                                                                                                                                                                                                    |

### `get(key, signal?, fill?)`

The value for `key`, reading it if nothing has. Callers arriving while the read
is in flight join it rather than starting a second one, and each caller learns
of its own cancellation alone, never another caller's. `get()` rejects
immediately if `signal` has already aborted, and as soon as it aborts while the
read is in flight. The read itself continues for the callers that still want it.
See [dataflow.md](dataflow.md).

`fill` overrides the constructor's for this call, for a read that is a closure
over the thing being read rather than a function of the key. The cache runs it
only on a miss. A call that hits a cached value or joins a read in flight gets
that read's result, and the cache ignores the call's own `fill`, so everything a
fill depends on has to be in the key. The cache drops a rejection rather than
caching it, so the next caller starts over.

### `getIfCached(key)`

The promise under `key`, or `undefined` if there is none. Marks the entry
most-recently-used exactly as `get()` does, so although it doesn't start a read,
it still touches LRU order.

The promise is the shared one, so awaiting it neither registers the caller as a
waiter nor re-reports the rejection per caller. `getIfCached()` also returns
`undefined` for a read every caller has already abandoned, because that entry
holds no value, only a rejection that has not arrived yet.

### `has(key)`

Whether `get()` would be answered from the cache, by a settled value or a read
still in flight. `has()` returns false for a read every caller has abandoned,
which `get()` would replace, and is the only lookup that does not touch LRU
order.

### `delete(key)` / `clear()`

Drop one entry, or all of them, crediting the weight back to the budget.
`clear()` also stops the idle sweep.

### `sweepIdle()`

Reclaim everything idle for longer than `idleTimeoutMs` now, rather than on the
interval, for example when a browser tab goes hidden. `sweepIdle()` does nothing
when no idle timeout is configured, and it skips reads in flight.

### `size` / `totalSize` / `maxSize`

`size` counts entries, including reads in flight. `totalSize` sums `sizeOf` over
the settled ones. `maxSize` is settable, and lowering it evicts immediately
rather than waiting for the next read.

### `waiterCount(key)`

How many caller signals the entry is still holding. It is exposed for tests,
because an entry that has leaked a thousand stale signals answers every read
exactly like one that has not, so only this accessor can detect the leak.

## `new SharedBudget(limit)`

One budget shared by several caches, which evicts the globally
least-recently-used entry across all of them. The budget holds its members
weakly, and every member must weigh in the same unit; see
[memory.md](memory.md#sharedbudget--when-the-cache-count-is-a-property-of-the-workload).

```js
const budget = new SharedBudget(1024 * 2 ** 20)
const cache = new SharedReadCache({ budget, sizeOf: v => v.byteLength, fill })
```

- **`limit`** — settable; lowering it evicts immediately.
- **`total`** — settled weight held across every live member.
- **`size`** — members still alive, exposed for tests.
- **`evict()`** — evict until back under the limit, or until no member will give
  up another. The member cache calls it for you when it settles a read.
- **`register(member)`** / **`charge(membership, delta)`** — how a
  `BudgetMember` enrols and reports its weight. `SharedReadCache` does this in
  its constructor; there is no reason for a consumer to call either.

## `throwIfAborted(signal?)`

Throws `signal.reason` if the signal has aborted, and a `DOMException` named
`AbortError` if there is no reason. Exported because the cache uses it and
consumers doing the same check want the same semantics.

The package does not use `signal.throwIfAborted()`, for two reasons. That method
assumes a _real_ `AbortSignal`, and consumers hand-roll duck-typed ones, where
the missing method throws a `TypeError` rather than the cancellation the caller
asked for, a strictly worse failure. It also sets a browser floor of March 2022
(Safari 15.4 / Chrome 100 / Firefox 97) that consumers of this package otherwise
do not need, because they touch only `.aborted`.

## `BudgetMember`

What a `SharedBudget` needs from a cache: `lruSpare()` and `release(cacheKey)`,
which `SharedReadCache` implements. Exported as a type for anyone reading the
budget's signature, not as an extension point.

## `Budget` / `BudgetMembership`

The type of the `budget` option: `register`, `charge`, `nextSeq` and `evict`,
which `SharedBudget` implements. The option takes the interface rather than the
class so that the budget and the cache can come from two installs of this
package, such as an application creating the budget and `@gmod/bam` constructing
the cache. A class with private fields from one install would not typecheck
against its copy from the other. `BudgetMembership` is the handle `register`
returns.

`BudgetMembership` has one field, `held`: the weight its member currently adds
to the budget's total. `SharedBudget`'s `charge` adds `delta` to it.
