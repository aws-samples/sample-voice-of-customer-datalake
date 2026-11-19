/**
 * @fileoverview The Flow tab (UX §5.4): the whole path on one outline, every rule editable in place. Its header
 * counts the questions, the endings and the paths, and the shortest and longest path in questions. Past 12
 * questions, the ones without rules fold to one line (Expand all / Collapse all).
 *
 * @module pages/FeedbackForms/logic/FlowTab
 */
import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { GitBranch } from 'lucide-react'
import { useDraft } from '../builder/formDraftContext'
import { formPaths } from '../model/paths'
import FlowOutline from './FlowOutline'

const FOLD_FROM = 12
const NONE_MARKED: ReadonlySet<string> = new Set()

export default function FlowTab() {
  const { t } = useTranslation('feedbackForms')
  const { form, ai } = useDraft()
  const paths = useMemo(() => formPaths(form), [form])
  const foldable = form.questions.length > FOLD_FROM
  const [expanded, setExpanded] = useState(false)
  const hasRules = form.questions.some((question) => (question.logic ?? []).length > 0)
  const summary = [
    t('flow.questions', { count: form.questions.length }),
    t('flow.endings', { count: form.endings.length }),
    t('flow.paths', { count: paths.total }),
    t('flow.lengths', { min: paths.shortest, max: paths.longest }),
  ].join(' · ')
  return (
    <section aria-labelledby="flow-heading" className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 id="flow-heading" className="text-sm font-semibold tracking-tight text-text-strong">{t('flow.title')}</h2>
          <p className="text-[13px] text-muted tabular-nums" data-testid="flow-summary">{summary}</p>
        </div>
        {foldable && (
          <button type="button" className="btn btn-secondary btn-sm" aria-pressed={expanded} onClick={() => setExpanded((on) => !on)}>
            {expanded ? t('flow.collapseAll') : t('flow.expandAll')}
          </button>
        )}
      </div>
      {!hasRules && (
        <p role="note" className="flex items-start gap-2 rounded-lg border border-border bg-bg-accent p-3 text-sm text-text">
          <GitBranch size={16} className="mt-0.5 shrink-0 text-muted" aria-hidden="true" />{t('flow.noRules')}
        </p>
      )}
      <FlowOutline form={form} paths={paths} folded={foldable && !expanded} marked={ai?.marked ?? NONE_MARKED} />
    </section>
  )
}
