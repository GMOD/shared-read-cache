# How a `get()` flows

<img src="img/dataflow.svg" alt="shared-read-cache data flow" width="700">

[dataflow.dot](img/dataflow.dot) is the source; see
[CONTRIBUTING.md](../CONTRIBUTING.md) for how to re-render it.

A `get()` maps the key through `cacheKey`, and either joins the entry already
under that key or starts one, so either way the caller awaits **one** promise
per key. The read runs under an `AbortController` held by the entry, not under
any caller's signal, and `get()` checks the caller's own signal on the way in
and again when the read settles. The package exists for that separation, so that
a caller that gives up sees its own cancellation while everyone else keeps the
read.

Only two things about a key are per-caller: whether _this_ caller aborted, and
whether its abort was the last one. Everything else belongs to the entry: the
promise, the value, its weight against the budget and its position in LRU order.

## Why the caller's signal is checked twice

The first check is before the cache lookup. A caller can arrive with a signal
that has already fired, because the abort happened while some earlier `await`
was in flight and no code in between checked the signal. Such a caller must not
start a read it has no interest in, and must not be registered as a waiter on
someone else's read, which is the bug that shipped in
`@gmod/abortable-promise-cache`. An `abort` listener never fires on a signal
that aborted before the listener was added, so the waiter count could then never
reach zero, and the read became uncancellable for everyone joined to it.

The second check is after the shared promise settles, on both the resolve and
the reject path. The check reports this caller's own cancellation in preference
to the shared read's outcome. A caller that asked to stop gets its cancellation,
and if the read itself was cancelled, every joined caller asked for that.

## What `join` does with a signal

`join` registers a caller's interest, and handles four cases:

- **a real, unaborted signal** — added to the entry's waiter set with an `abort`
  listener. `{ once: true }` removes the listener when the abort fires, and the
  entry removes it by reference when the read settles. Without the removal on
  settle, a long-lived signal accumulates one listener per key it ever touches,
  each keeping its entry's value in memory. The entry removes the listener with
  `removeEventListener` rather than the `{ signal }` option, because Node holds
  that option's removal hook weakly and loses it across a GC when one target has
  two of them.
- **no signal** — the entry is _pinned_. A caller with no signal can never
  abort, so aborting every other caller still doesn't stop the read it joined.
  One signal-free consumer therefore makes that read uncancellable for everyone
  joined to it.
- **a duck-typed signal with no `addEventListener`** — pinned too, for the same
  reason: the cache has no way to detect when such a caller aborts. The caller
  still sees its own cancellation when the read settles, and loses only the
  ability to stop the read early, which an unsubscribable signal does not
  support anyway. Consumers do hand-roll `{ aborted: false }`; `@gmod/bam`'s
  `test/csi.test.ts` is one.
- **an already-aborted signal** — not a waiter (see above). Unreachable today,
  because `get()` rejects such a caller before `join` sees it, with no `await`
  in between.

Only the last waiter's abort reaches the read. The listener removes its signal
from the set, and aborts the entry's controller only if the set is now empty and
nothing pinned it.

Every waiter's abort rejects that waiter's promise at once, rather than when the
read it joined completes. Because one caller's abort does not stop a shared
read, a caller that learned of its own cancellation only when the shared promise
settled would wait out however long the _other_ callers' read took. Against a
transport that ignores its signal, such as a stalled fetch on a dead connection,
that caller would never learn of it at all. `get()` therefore races the shared
read against its own caller's signal, and unsubscribes whichever way the race
goes. A caller with a duck-typed signal cannot be raced, so it falls back to the
check after the read settles, which is the most an unsubscribable signal allows.

## Abandoned entries

A read every caller has abandoned has aborted its controller but has not
necessarily rejected yet, so for a moment the map still holds it. A caller that
joined such an entry would get a cancellation that has nothing to do with it, so
`get()` and `getIfCached()` both treat the entry as a miss: `get()` drops it and
starts a fresh read, and `getIfCached()` drops it and answers `undefined`.

## What settling does

Settling weighs a resolved read with `sizeOf`, adds that weight to the cache's
total, and charges it to the [shared budget](memory.md) if there is one. The
entry's idle clock starts here rather than at `start()`, because the clock
measures how long the value has existed. Started at `start()`, the clock would
let a read slower than `idleTimeoutMs` arrive already expired, and the sweep
would drop it before the query that triggered it got a single hit. Settling also
drops the entry's abort listeners and clears its waiter set, which is why
`get()` does not `join` an entry that has already settled, since no listener
would ever remove the caller.

A **rejected** read caches nothing. Settling drops the key before marking the
entry settled, so the next caller starts over rather than inheriting the
failure, and one transient error does not make the key fail for the life of the
cache.

Eviction runs only after settling; see [memory.md](memory.md).

## Omitted from the diagram

The diagram omits `getIfCached()`, which is the same lookup without the read,
without waiter registration and without the per-caller abort translation;
`has()`, which is the only lookup that does _not_ mark an entry
most-recently-used; and the `fill` passed per `get()` call rather than on the
constructor, which changes where the read comes from and nothing else about the
path.
