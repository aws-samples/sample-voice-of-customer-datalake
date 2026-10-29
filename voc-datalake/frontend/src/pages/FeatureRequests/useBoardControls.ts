/**
 * @fileoverview The board list's search, status filter and sort, kept in the URL
 * (`?q=&status=&sort=`) so a filtered board can be shared and survives a reload.
 *
 * Each change REPLACES the history entry (typing a search must not push one entry
 * per keystroke); a value at its default is left out of the URL, and every other
 * parameter (`?request=` of an open detail) is kept. An unknown sort reads as the
 * default; the status is any key here, and the list reads a key its board does not
 * have as "all statuses" (RequestList).
 *
 * A change is a PATCH (only the control that changed), written with `flushSync`: the data
 * router otherwise commits a search change in a transition, and its functional updater
 * receives the RENDERED params, so a control changed before that render (clear the search,
 * then pick a status) wrote the stale search back, and a status picked right after closing
 * a request's detail re-opened it (5.35, e2e feature-requests fr-03 / fr-06). The detail's
 * own `?request=` writer (FeatureBoard) flushes the same way.
 *
 * @module pages/FeatureRequests/useBoardControls
 */
import { useSearchParams } from 'react-router-dom'
import { STATUS_KEY } from '../../api/boardFields'
import { REQUEST_SORTS } from './boardFormat'
import type { RequestSort } from './boardFormat'

export interface BoardControls {
  /** A status key, or `all`. */
  readonly status: string
  readonly query: string
  readonly sort: RequestSort
}

const DEFAULTS: BoardControls = { status: 'all', query: '', sort: 'newest' }
const PARAM = { query: 'q', status: 'status', sort: 'sort' } as const

export const isRequestSort = (value: string): value is RequestSort => REQUEST_SORTS.some((sort) => sort === value)

function readControls(params: URLSearchParams): BoardControls {
  const status = params.get(PARAM.status) ?? ''
  const sort = params.get(PARAM.sort) ?? ''
  return {
    status: STATUS_KEY.test(status) ? status : DEFAULTS.status,
    query: params.get(PARAM.query) ?? DEFAULTS.query,
    sort: isRequestSort(sort) ? sort : DEFAULTS.sort,
  }
}

function writeParam(params: URLSearchParams, name: string, value: string, fallback: string): void {
  if (value === fallback) params.delete(name)
  else params.set(name, value)
}

export function useBoardControls(): readonly [BoardControls, (change: Partial<BoardControls>) => void] {
  const [params, setParams] = useSearchParams()
  const update = (change: Partial<BoardControls>) => {
    setParams((prev) => {
      const out = new URLSearchParams(prev)
      if (change.query !== undefined) writeParam(out, PARAM.query, change.query, DEFAULTS.query)
      if (change.status !== undefined) writeParam(out, PARAM.status, change.status, DEFAULTS.status)
      if (change.sort !== undefined) writeParam(out, PARAM.sort, change.sort, DEFAULTS.sort)
      return out
    }, { replace: true, flushSync: true })
  }
  return [readControls(params), update]
}
