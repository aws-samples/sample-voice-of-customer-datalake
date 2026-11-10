/**
 * @fileoverview Small value renderers of the connector approval cards: muted
 * placeholders, code, URLs with the host emphasised, one-per-line lists.
 *
 * @module assistant/approvals/previews/ScraperValues
 */
import type { ReactNode } from 'react'

export const Muted = ({ text }: Readonly<{ text: string }>) => <span className="italic text-muted">{text}</span>
export const Code = ({ text }: Readonly<{ text: string }>) => <code className="text-[12px]">{text}</code>

/** A URL with its host emphasised, so the user sees which site is fetched. */
export function UrlLine({ url }: Readonly<{ url: string }>) {
  const parsed = URL.canParse(url) ? new URL(url) : null
  const start = parsed === null ? -1 : url.indexOf(parsed.host)
  if (parsed === null || start < 0) return <span className="font-mono text-[12px]">{url}</span>
  const { host, protocol } = parsed
  return (
    <span className="font-mono text-[12px] break-all">
      <span className="text-muted">{url.slice(0, start) || `${protocol}//`}</span>
      <strong className="font-semibold text-text-strong">{host}</strong>
      <span>{url.slice(start + host.length)}</span>
    </span>
  )
}

export function Lines({ items, empty }: Readonly<{ items: readonly ReactNode[]; empty: string }>) {
  if (items.length === 0) return <Muted text={empty} />
  return <ul className="space-y-0.5">{items.map((item, i) => <li key={i}>{item}</li>)}</ul>
}
