/** The error a cancelled wait rejects with: a `DOMException` named `AbortError`, as `fetch` uses. */
export function abortError(): Error {
  return new DOMException('The request was aborted.', 'AbortError')
}
