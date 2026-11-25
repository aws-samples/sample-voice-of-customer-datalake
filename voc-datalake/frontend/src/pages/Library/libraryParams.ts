/**
 * @fileoverview The item the Library page has open in its preview drawer, and the page of its text, in the address:
 * `/library?item=<item_id>&page=<n>`. The assistant's citation chips (`[#slug p.N]`) link there, so a passage opens
 * at its page; a row of the list opens the same way, and Back closes the drawer.
 *
 * @module pages/Library/libraryParams
 */
import { useCallback } from 'react'
import { useSearchParams } from 'react-router-dom'
import { LIBRARY_ITEM_ID } from '../../api/librarySchema'

const ITEM_PARAM = 'item'
const PAGE_PARAM = 'page'

/** A `page` as a page number (from 1), else 1. */
function pageOf(raw: string | null): number {
  const page = Number(raw)
  return Number.isInteger(page) && page >= 1 ? page : 1
}

export interface PreviewParams {
  /** The open item's id, or null (none, or not an item id). */
  readonly itemId: string | null
  readonly page: number
  readonly open: (itemId: string) => void
  readonly setPage: (page: number) => void
  readonly close: () => void
}

export function usePreviewParams(): PreviewParams {
  const [searchParams, setSearchParams] = useSearchParams()
  const raw = searchParams.get(ITEM_PARAM)
  const itemId = raw !== null && LIBRARY_ITEM_ID.test(raw) ? raw : null
  const page = pageOf(searchParams.get(PAGE_PARAM))
  const write = useCallback((change: (next: URLSearchParams) => void, replace: boolean) => {
    setSearchParams((current) => {
      const next = new URLSearchParams(current)
      change(next)
      return next
    }, { replace })
  }, [setSearchParams])
  const open = useCallback((id: string) => write((next) => {
    next.set(ITEM_PARAM, id)
    next.delete(PAGE_PARAM)
  }, false), [write])
  const setPage = useCallback((value: number) => write((next) => { next.set(PAGE_PARAM, String(value)) }, true), [write])
  // Replacing: closing is no place to come back to (Back from the list leaves it).
  const close = useCallback(() => write((next) => {
    next.delete(ITEM_PARAM)
    next.delete(PAGE_PARAM)
  }, true), [write])
  return { itemId, page, open, setPage, close }
}
