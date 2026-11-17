/**
 * @fileoverview A text shown exactly as stored (`.code-view`): monospace 12 px, its line numbers (decorative:
 * `aria-hidden`, never selected or copied), Wrap lines (on by default; off, a long line scrolls sideways inside the
 * view) and Copy (the text itself). The text is a named, focusable region, so a keyboard scrolls it. Text only: no
 * syntax highlighting and nothing interpreted (D6-5); the reader's Source view, front-matter that is not a flat
 * list, and code documents use it.
 *
 * @module components/Document/text/CodeView
 */
import clsx from 'clsx'
import { Check, Copy, WrapText } from 'lucide-react'
import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useCopyToClipboard } from '../../../hooks/useCopyToClipboard'

interface CodeViewProps {
  readonly text: string
  /** The region's accessible name ("Source of …", "Properties"). */
  readonly label: string
  readonly className?: string
}

/** The text's lines as shown: a final newline ends the last line, it does not start an empty one. */
function linesOf(text: string): readonly string[] {
  const lines = text.replace(/\r\n/gu, '\n').split('\n')
  return lines.length > 1 && lines.at(-1) === '' ? lines.slice(0, -1) : lines
}

export default function CodeView({ text, label, className }: CodeViewProps) {
  const { t } = useTranslation('documents')
  const [wrap, setWrap] = useState(true)
  const { tryCopy, copiedKey } = useCopyToClipboard()
  const lines = useMemo(() => linesOf(text), [text])
  return (
    <div className={clsx('code-view', className)} data-wrap={wrap ? '' : undefined}>
      <div className="code-view__bar">
        <span className="mr-auto">{t('code.lines', { n: lines.length })}</span>
        <button type="button" className="btn btn-ghost btn-sm" aria-pressed={wrap} onClick={() => setWrap((on) => !on)}>
          <WrapText size={14} aria-hidden="true" />{t('code.wrap')}
        </button>
        <button type="button" className="btn btn-ghost btn-sm" onClick={() => void tryCopy(text)}>
          {copiedKey === null ? <Copy size={14} aria-hidden="true" /> : <Check size={14} aria-hidden="true" />}
          {copiedKey === null ? t('code.copy') : t('code.copied')}
        </button>
        <span role="status" className="sr-only">{copiedKey === null ? '' : t('code.copied')}</span>
      </div>
      <div role="region" aria-label={label} tabIndex={0} className="code-view__body focus-ring">
        {lines.map((line, index) => (
          <div key={index} className="code-view__line">
            <span aria-hidden="true" className="code-view__number">{index + 1}</span>
            <span className="code-view__text">{line === '' ? '\u200b' : line}</span>
          </div>
        ))}
      </div>
    </div>
  )
}
