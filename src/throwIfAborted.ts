/**
 * Throws if `signal` has been aborted, matching the semantics of
 * `signal.throwIfAborted()` without requiring either that method or `reason`.
 *
 * Two reasons not to call the built-in directly. It assumes a *real*
 * `AbortSignal`, and callers pass duck-typed ones — `@gmod/bam`'s
 * `test/csi.test.ts` casts a bare `{ aborted }` through `as AbortSignal`, which
 * is a fair model of what consumers do. Calling a missing method there is a
 * `TypeError` rather than the cancellation the caller asked for, which is a
 * strictly worse failure.
 *
 * And it sets a browser floor. `AbortSignal.prototype.throwIfAborted` and
 * `AbortSignal.reason` are Safari 15.4 / Chrome 100 / Firefox 97 (March 2022),
 * higher than the consumers of this package otherwise need — they touch only
 * `.aborted`, and `generic-filehandle2` only forwards a signal to `fetch`. A
 * few lines here keep that floor where it was.
 */
export function throwIfAborted(signal?: AbortSignal) {
  if (signal?.aborted) {
    const reason: unknown = signal.reason
    // Spec-faithful: throwIfAborted throws `reason` verbatim, and `reason` is
    // whatever the caller passed to abort() — `controller.abort('too slow')`
    // makes it a string. Coercing it to an Error here would hide that from a
    // consumer who set it deliberately.
    // eslint-disable-next-line @typescript-eslint/only-throw-error
    throw reason === undefined
      ? new DOMException('This operation was aborted', 'AbortError')
      : reason
  }
}
