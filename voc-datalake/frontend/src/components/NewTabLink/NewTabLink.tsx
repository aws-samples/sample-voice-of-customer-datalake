/**
 * @fileoverview A link that opens in a new tab (`noopener noreferrer`): its words, the external-link icon after them,
 * and the caller's "opens in a new tab" said to a screen reader only. A form's Open (the forms builder's Test and
 * Share tabs) and a data source's setup guide links.
 *
 * @module components/NewTabLink/NewTabLink
 */
import { ExternalLink } from 'lucide-react'
import type { ReactNode } from 'react'

export function NewTabLink({ href, className, iconSize, newTab, children }: Readonly<{
  href: string
  className: string
  iconSize: number
  /** "(opens in a new tab)", in the caller's words. */
  newTab: string
  children: ReactNode
}>) {
  return (
    <a href={href} target="_blank" rel="noopener noreferrer" className={className}>
      {children}
      <ExternalLink size={iconSize} aria-hidden="true" />
      <span className="sr-only">{newTab}</span>
    </a>
  )
}
