# How a `get()` flows

<img src="img/dataflow.svg" alt="shared-read-cache data flow" width="700">

[dataflow.dot](img/dataflow.dot) is the source; see
[CONTRIBUTING.md](../CONTRIBUTING.md) for how to re-render it.

A `get()` maps the key through `cacheKey`, and either joins the entry already
under that key or starts one. Either way the caller ends up awaiting **one**
promise per key — the read runs under an `AbortController` the entry owns, not
under any caller's signal, and the caller's own signal is checked on the way in
and again when the read settles. That separation is why the package exists: a
caller that gives up is told it gave up, and everyone else keeps the read.

Only two things about a key are per-caller: whether _this_ caller aborted, and
whether its abort was the last one. Everything else — the promise, the value,
its weight against the budget, its position in LRU order — belongs to the entry.

## Why the caller's signal is checked twice

The first check is before the cache lookup. A caller can arrive with a signal
that has already fired, because the abort landed while some earlier `await` was
in flight and nothing in between looked at it. Such a caller must not start a
read it has no interest in, and — the bug that shipped in
`@gmod/abortable-promise-cache` — must not be registered as a waiter on someone
else's, since an `abort` listener never fires on a signal that aborted before
the listener was added. The waiter count could then never reach zero, so the
read turned uncancellable for everyone joined to it.

The second check is after the shared promise settles, on both the resolve and
the reject path. It reports this caller's own cancellation in preference to the
shared read's outcome: a caller that asked to stop is told it stopped, and if
the read itself was cancelled, that is because every joined caller asked for it.

## What `join` does with a signal

`join` is where a caller's interest is registered, and it has four cases:

- **a real, unaborted signal** — added to the entry's waiter set with an `abort`
  listener. `{ once: true }` takes the listener off when the abort fires, and
  the entry removes it by reference when the read settles. Without that second
  half, a long-lived signal accumulates one listener per key it ever touches,
  each pinning its entry's value. The removal is `removeEventListener` rather
  than the `{ signal }` option, because Node holds that option's removal hook
  weakly and loses it across a GC when one target carries two of them.
- **no signal** — the entry is _pinned_. A caller with no signal can never
  abort, so aborting every other caller still doesn't stop the read it joined.
  One signal-free consumer therefore makes that read uncancellable for everyone
  joined to it.
- **a duck-typed signal with no `addEventListener`** — pinned too, for the same
  reason: the cache has no way to detect when such a caller aborts. It is still
  told about its own cancellation when the read settles; what it loses is only
  the ability to stop the read early, which an unsubscribable signal does not
  support anyway. Consumers really do hand-roll `{ aborted: false }` —
  `@gmod/bam`'s `test/csi.test.ts` is one.
- **an already-aborted signal** — not a waiter (see above). Unreachable today,
  because `get()` rejects such a caller before `join` sees it, with no `await`
  in between.

Only the last waiter's abort reaches the read: the listener removes its signal
from the set, and aborts the entry's controller only if the set is now empty and
nothing pinned it.

Every waiter's abort reaches that waiter, though, and does so at once rather
than when the read it joined lands. The two are separate on purpose: sharing
means one caller's abort does not stop the read, so a caller told about its own
cancellation only once the shared promise settled waited out however long the
_other_ callers' read took — and against a transport that ignores its signal, a
stalled fetch on a dead connection, it was never told at all. So `get()` races
the shared read against its own caller's signal, unsubscribing whichever way
that goes. A caller with a duck-typed signal cannot be raced and falls back to
the check after the read settles, which is all an unsubscribable signal could
ever have asked for.

## The doomed-entry branch

A read every caller has abandoned has aborted its controller but has not
necessarily rejected yet, so for a moment the map still holds it. Joining one
means inheriting a cancellation that has nothing to do with you, so both `get()`
and `getIfCached()` treat it as a miss: `get()` drops it and starts a fresh
read, `getIfCached()` drops it and answers `undefined`.

## What settling does

Settling weighs a resolved read with `sizeOf`, adds that weight to the cache's
total, and charges it to the [shared budget](memory.md) if there is one. The
entry's idle clock starts here rather than at `start()` — the clock is about the
value existing, so a read slower than `idleTimeoutMs` would otherwise arrive
already expired and be swept before the query that triggered it got a single
hit. Settling also drops the entry's abort listeners and clears its waiter set,
which is why `get()` does not `join` an entry that has already settled: no
listener would ever take the caller back out.

A **rejected** read caches nothing. Settling drops the key before marking the
entry settled, so the next caller starts over rather than inheriting the
failure, and one transient error does not poison the key for the life of the
cache.

Then, and only then, eviction runs — see [memory.md](memory.md).

## What the diagram leaves out

`getIfCached()`, which is the same lookup without the read, without waiter
registration and without the per-caller abort translation; `has()`, which is the
only lookup that does _not_ mark an entry most-recently-used; and the `fill`
passed per `get()` call rather than on the constructor, which changes where the
read comes from and nothing else about the path.
