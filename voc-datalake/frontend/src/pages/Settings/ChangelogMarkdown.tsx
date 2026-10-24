/**
 * @fileoverview One changelog release rendered as markdown (react-markdown +
 * remark-gfm, `.md-content`, no raw HTML). Links go through
 * `resolveChangelogLink`: web links and repo paths open the target in a new
 * tab, everything else is plain text; images render as their alt text.
 *
 * @module pages/Settings/ChangelogMarkdown
 */
import type { ComponentProps } from 'react'
import ReactMarkdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { resolveChangelogLink } from './changelog'

function ChangelogLink({ href, children }: ComponentProps<'a'>) {
  const target = resolveChangelogLink(href)
  if (target.kind === 'text') return <span>{children}</span>
  return <a href={target.href} target="_blank" rel="noopener noreferrer" className="link">{children}</a>
}

function ChangelogImage({ alt }: ComponentProps<'img'>) {
  return <span>{alt}</span>
}

const COMPONENTS: Components = { a: ChangelogLink, img: ChangelogImage }

export default function ChangelogMarkdown({ source }: Readonly<{ source: string }>) {
  return (
    <div className="md-content text-sm">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={COMPONENTS}>{source}</ReactMarkdown>
    </div>
  )
}
