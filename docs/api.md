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
common: a memo whose fill is a closure passed per `get()` call.

The package exports the type of the options object as
`SharedReadCacheOptions<K, V>`.

| option              | default       | what it does                                                                                                                                                                                                                                                                                                                                      |
| ------------------- | ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `fill(key, signal)` | none          | Performs the read, under the **shared** signal — it fires only once every caller waiting on this key has aborted, never one caller's own. Either this or a per-call `fill` must be present.                                                                                                                                                       |
| `cacheKey(key)`     | `String(key)` | Maps a key to its cache key.                                                                                                                                                                                                                                                                                                                      |
| `sizeOf(value)`     | `() => 1`     | Weighs a settled value against the budget. The default makes the budget an entry count. A value it cannot weigh — a throw, `NaN`, a negative — is served to the caller as normal but not cached, since the budget could not account for it. See [memory.md](memory.md#why-sizeof), and [consumers.md](consumers.md) for what each package weighs. |
| `maxSize`           | `Infinity`    | Budget, in whatever unit `sizeOf` returns.                                                                                                                                                                                                                                                                                                        |
| `idleTimeoutMs`     | none          | Drop an entry once nothing has asked for it for this long. `0`, a negative and `Infinity` all mean never.                                                                                                                                                                                                                                         |
| `budget`            | none          | A [`SharedBudget`](#new-sharedbudgetlimit) this cache joins. Composes with `maxSize` rather than replacing it.                                                                                                                                                                                                                                    |

### `get(key, signal?, fill?)`

The value for `key`, reading it if nothing has. Callers arriving while the read
is in flight join it rather than starting a second one, and each is told about
its own cancellation alone. Rejects immediately if `signal` has already aborted,
and as soon as it aborts while the read is in flight — the read itself runs on
for whoever still wants it. See [dataflow.md](dataflow.md).

`fill` overrides the constructor's for this call, for a read that is a closure
over the thing being read rather than a function of the key. The cache runs it
only on a miss: a call that hits a cached value or joins a read in flight gets
that read's result and its own `fill` is ignored, so everything a fill depends
on has to be in the key. The cache drops a rejection rather than caching it, so
the next caller starts over.

### `getIfCached(key)`

The promise under `key`, or `undefined` if there is none. Marks the entry
most-recently-used exactly as `get()` does. It doesn't start a read, but it
isn't a passive inspection either — it still touches LRU order.

The promise is the shared one, so awaiting it neither registers the caller as a
waiter nor re-reports the rejection per caller. `undefined` too for a read every
caller has already abandoned, which is not a cached value but a rejection that
has not landed yet.

### `has(key)`

Whether `get()` would be answered from the cache, by a settled value or a read
still in flight. False for a read every caller has abandoned, which `get()`
would replace. The only lookup that does not touch LRU order.

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
that has not, so only this accessor would catch it.

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
strictly worse failure. It also sets a browser floor of March 2022 (Safari 15.4
/ Chrome 100 / Firefox 97) that consumers of this package otherwise do not need:
they touch only `.aborted`.

## `BudgetMember`

What a `SharedBudget` needs from a cache: `lruSpare()` and `release(cacheKey)`.
`SharedReadCache` implements it. Exported as a type for anyone reading the
budget's signature, not as an extension point.

## `Budget` / `BudgetMembership`

The type of the `budget` option: `register`, `charge`, `nextSeq` and `evict`,
which `SharedBudget` implements. The option takes the interface rather than the
class so that the budget and the cache can come from two installs of this
package — an application creating the budget and `@gmod/bam` constructing the
cache, say — where a class with private fields would not typecheck against its
own copy. `BudgetMembership` is the handle `register` returns.

`BudgetMembership` has one field, `held`: the weight its member currently adds
to the budget's total. `SharedBudget`'s `charge` adds `delta` to it.
