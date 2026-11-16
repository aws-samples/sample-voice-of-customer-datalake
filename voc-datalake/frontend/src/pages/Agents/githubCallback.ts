/**
 * @fileoverview What the two pages GitHub sends a person back to share (Agents → Connections → Connect GitHub,
 * 7.45.00): the query they are opened with, read once and then removed from the address, and the one request each
 * makes with it.
 *
 * The creation's `code` is a bearer credential for an hour (whoever holds it gets the new App's key from GitHub) and
 * the states are single use, so the page takes them at its first render, replaces the address without them (no
 * history entry keeps them; the referrer policy is same-origin), and sends its request exactly once: a guard in a ref
 * keeps React's StrictMode, which runs every effect twice in development, and any re-render from sending it again.
 *
 * @module pages/Agents/githubCallback
 */
import { useEffect, useRef, useState } from 'react'
import { useSearchParams } from 'react-router-dom'

/** One request's state: none made (`idle`), on its way, answered, or refused. */
export type RequestOutcome<T> =
  | { kind: 'idle' }
  | { kind: 'pending' }
  | { kind: 'done'; answer: T }
  | { kind: 'failed'; error: unknown }

/**
 * The address's query as the page was opened with it; `names` are removed from the address at once (a replace, so
 * the back button never returns to them), the rest of the query stays.
 */
export function useTakenQuery(names: readonly string[]): URLSearchParams {
  const [params, setParams] = useSearchParams()
  const [taken] = useState(() => new URLSearchParams(params))
  useEffect(() => {
    if (!names.some((name) => params.has(name))) return
    const rest = new URLSearchParams(params)
    for (const name of names) rest.delete(name)
    setParams(rest, { replace: true })
  }, [names, params, setParams])
  return taken
}

/**
 * `request`'s outcome, the request sent once at the first mount (never again, whatever re-renders or re-runs the
 * effect); `request` null: none is sent (`idle`). Give it a stable function (a state's initial value).
 */
export function useSingleRequest<T>(request: (() => Promise<T>) | null): RequestOutcome<T> {
  const sent = useRef(false)
  const [outcome, setOutcome] = useState<RequestOutcome<T>>(() => (request === null ? { kind: 'idle' } : { kind: 'pending' }))
  useEffect(() => {
    if (request === null || sent.current) return
    sent.current = true
    void request().then(
      (answer) => { setOutcome({ kind: 'done', answer }) },
      (error: unknown) => { setOutcome({ kind: 'failed', error }) },
    )
  }, [request])
  return outcome
}
