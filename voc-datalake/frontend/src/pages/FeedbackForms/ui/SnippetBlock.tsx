/**
 * @fileoverview A snippet to paste (the iframe, the script, a link or code with hidden fields): the text as it is, in a
 * `<pre>` the keyboard can scroll (a named, focusable region), and Copy (main's `useCopyToClipboard`). Nothing is
 * interpreted or highlighted.
 *
 * @module pages/FeedbackForms/ui/SnippetBlock
 */
import { Check, Copy } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useCopyToClipboard } from '../../../hooks/useCopyToClipboard'

interface SnippetBlockProps {
  readonly text: string
  /** The region's accessible name ("Embed with an iframe", "Link code"). */
  readonly label: string
}

export default function SnippetBlock({ text, label }: SnippetBlockProps) {
  const { t } = useTranslation('feedbackForms')
  const { tryCopy, copiedKey } = useCopyToClipboard()
  const copied = copiedKey !== null
  return (
    <div className="rounded-md border border-border bg-elevated">
      <div className="flex justify-end border-b border-border px-2 py-1">
        <button type="button" className="btn btn-ghost btn-sm" onClick={() => void tryCopy(text)}>
          {copied ? <Check size={14} aria-hidden="true" /> : <Copy size={14} aria-hidden="true" />}
          {copied ? t('share.copied') : t('share.copy')}
        </button>
        <span role="status" className="sr-only">{copied ? t('share.copied') : ''}</span>
      </div>
      <pre role="region" aria-label={label} tabIndex={0}
        className="focus-ring max-h-64 overflow-auto whitespace-pre-wrap break-all p-3 font-mono text-[12px] text-text">
        {text}
      </pre>
    </div>
  )
}
