/**
 * @fileoverview The one check for a link whose URL comes from data (a review's source page, a
 * release citation, a design reference): only an absolute http(s) URL becomes an `href` (FE-7).
 * React already neuters `javascript:`; this also refuses `data:`, `vbscript:`, relative and
 * malformed values, so a stored URL can never become anything but a web link.
 * @module utils/httpHref
 */
import { classifyHref } from '../assistant/components/safeHref'

/** The normalised `href` for an absolute http(s) URL, else undefined (render no link). */
export function httpHref(value: string | null | undefined): string | undefined {
  const classified = classifyHref(value ?? undefined)
  return classified.kind === 'external' ? classified.href : undefined
}
