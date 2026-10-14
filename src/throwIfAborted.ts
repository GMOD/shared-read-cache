/**
 * Throws if `signal` has been aborted, like `signal.throwIfAborted()`, but
 * also for a duck-typed `{ aborted }` signal and on browsers that predate that
 * method. See docs/api.md.
 */
export function throwIfAborted(signal?: AbortSignal) {
  if (signal?.aborted) {
    throw abortReason(signal)
  }
}

/**
 * `signal.reason` verbatim, even a string, or an `AbortError` when there is
 * none. Annotated `unknown` because only-throw-error rejects the inferred type.
 */
export function abortReason(signal: AbortSignal): unknown {
  const reason: unknown = signal.reason
  return reason === undefined
    ? new DOMException('This operation was aborted', 'AbortError')
    : reason
}
