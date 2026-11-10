/**
 * @fileoverview In-page anchors of the Scrapers page: each scraper card carries
 * `id="scraper-<id>"`, so a link to `/scrapers#scraper-<id>` (the assistant's
 * result link after it created or updated one) lands on that card.
 *
 * @module pages/Scrapers/scraperAnchor
 */
import { useEffect } from 'react'
import { useLocation } from 'react-router-dom'

export function scraperAnchorId(scraperId: string): string {
  return `scraper-${scraperId}`
}

/** Scroll the element named by the URL hash into view once the list it lives in has rendered. */
/** The element id a `#hash` names; null for an empty or malformed (undecodable) hash. */
function hashTarget(hash: string): string | null {
  if (hash.length < 2) return null
  try {
    return decodeURIComponent(hash.slice(1))
  } catch {
    return null
  }
}

/** Scroll the element named by the URL hash into view once the list it lives in has rendered. */
export function useScrollToHash(ready: boolean): void {
  const { hash } = useLocation()
  useEffect(() => {
    const target = ready ? hashTarget(hash) : null
    if (target !== null) document.getElementById(target)?.scrollIntoView({ block: 'start' })
  }, [ready, hash])
}
