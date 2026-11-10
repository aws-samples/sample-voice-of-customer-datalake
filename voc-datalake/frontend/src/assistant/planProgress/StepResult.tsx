/**
 * @fileoverview The result of a done analysis (`think`) step: its stored text
 * as markdown (safe links only, never images — the same rendering as an
 * assistant answer), collapsed behind "Show the full result" when long. A done
 * analysis step that stored nothing says so instead of showing nothing.
 *
 * @module assistant/planProgress/StepResult
 */
import { useId, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { useTranslation } from 'react-i18next'
import { clsx } from 'clsx'
import { NoImage, SafeLink } from '../components/SafeLink'

/** Results longer than this start collapsed. */
const RESULT_COLLAPSE_CHARS = 600
const MARKDOWN_COMPONENTS = { a: SafeLink, img: NoImage }

function ResultBody({ text }: Readonly<{ text: string }>) {
  const { t } = useTranslation('assistantTools')
  const long = text.length > RESULT_COLLAPSE_CHARS
  const [expanded, setExpanded] = useState(false)
  const id = useId()
  const collapsed = long && !expanded
  return (
    <div className="space-y-1">
      <div id={id} data-collapsed={collapsed}
        className={clsx('md-content break-words text-[13px] text-text', collapsed && 'max-h-40 overflow-hidden')}>
        <ReactMarkdown remarkPlugins={[remarkGfm]} components={MARKDOWN_COMPONENTS}>{text}</ReactMarkdown>
      </div>
      {long && (
        <button type="button" className="text-[12px] font-medium link" aria-expanded={expanded} aria-controls={id}
          onClick={() => setExpanded((open) => !open)}>
          {expanded ? t('preview.plan.result.showLess') : t('preview.plan.result.showMore')}
        </button>
      )}
    </div>
  )
}

export function StepResult({ outputs }: Readonly<{ outputs: Record<string, string> }>) {
  const { t } = useTranslation('assistantTools')
  const entries = Object.entries(outputs).filter(([, value]) => value.trim() !== '')
  if (entries.length === 0) {
    return <p className="text-[12px] italic text-muted" data-testid="plan-step-no-result">{t('preview.plan.result.none')}</p>
  }
  return (
    <section className="rounded-md border border-border bg-bg-accent px-2.5 py-2" aria-label={t('preview.plan.result.label')}
      data-testid="plan-step-result">
      {entries.map(([name, text]) => <ResultBody key={name} text={text} />)}
    </section>
  )
}
