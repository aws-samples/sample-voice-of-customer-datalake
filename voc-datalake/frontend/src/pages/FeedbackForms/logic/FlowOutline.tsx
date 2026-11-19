/**
 * @fileoverview The Flow outline (UX §5.4): START, every question with its rules (FlowQuestion), then END with each
 * ending, "default" for the first and "reached by N paths". An outline, not a canvas: read top to bottom, worked with
 * a keyboard. One rule is open in place at a time.
 *
 * @module pages/FeedbackForms/logic/FlowOutline
 */
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { AlertTriangle, Flag, Sparkles } from 'lucide-react'
import type { FormV2 } from '../model/formsV2'
import { textIn } from '../model/i18nText'
import type { FormPaths } from '../model/paths'
import FlowQuestion from './FlowQuestion'
import type { OpenRule } from './FlowQuestion'

function FlowEnding({ form, id, index, ways, marked }: Readonly<{ form: FormV2; id: string; index: number; ways: number; marked: boolean }>) {
  const { t } = useTranslation('feedbackForms')
  const ending = form.endings.find((e) => e.id === id)
  if (ending === undefined) return null
  const unreached = index > 0 && ways === 0
  return (
    <li className="rounded-lg border border-border p-3" data-testid={`flow-${id}`}>
      <div className="flex flex-wrap items-center gap-2">
        <Flag size={14} className="shrink-0 text-muted" aria-hidden="true" />
        <h3 className="min-w-0 flex-1 truncate text-sm font-medium text-text-strong" title={textIn(ending.title, form.language)}>{textIn(ending.title, form.language)}</h3>
        {marked && <span className="badge badge-aim inline-flex items-center gap-1"><Sparkles size={12} aria-hidden="true" />{t('flow.ai')}</span>}
        {index === 0 && <span className="badge badge-muted">{t('flow.default')}</span>}
        <span className="text-[12px] text-muted tabular-nums">{t('flow.reachedBy', { count: ways })}</span>
      </div>
      {unreached && (
        <p className="ml-6 mt-1 flex items-center gap-1.5 text-[12px] text-warn">
          <AlertTriangle size={13} aria-hidden="true" />{t('problems.unreachableEnding')}
        </p>
      )}
    </li>
  )
}

export default function FlowOutline({ form, paths, folded, marked }: Readonly<{
  form: FormV2
  paths: FormPaths
  /** Questions without rules fold to one line. */
  folded: boolean
  /** The ids the AI added or changed. */
  marked: ReadonlySet<string>
}>) {
  const { t } = useTranslation('feedbackForms')
  const [open, setOpen] = useState<OpenRule | null>(null)
  return (
    <div className="space-y-3">
      <p className="text-[11px] font-semibold uppercase tracking-[.08em] text-muted-strong">
        {t('flow.start')} <span className="ml-2 font-normal normal-case tracking-normal text-muted">
          {form.welcome.enabled ? t('flow.welcomeOn') : t('flow.welcomeOff')}
        </span>
      </p>
      <ol className="space-y-2" aria-label={t('flow.questionsLabel')}>
        {form.questions.map((question, index) => (
          <FlowQuestion key={question.id} questionId={question.id} number={index + 1}
            reached={paths.questionWays.get(question.id) ?? 0} marked={marked.has(question.id)}
            folded={folded && (question.logic ?? []).length === 0} open={open} onOpen={setOpen} onClose={() => setOpen(null)} />
        ))}
      </ol>
      <p className="text-[11px] font-semibold uppercase tracking-[.08em] text-muted-strong">{t('flow.end')}</p>
      <ul className="space-y-2" aria-label={t('flow.endingsLabel')}>
        {form.endings.map((ending, index) => (
          <FlowEnding key={ending.id} form={form} id={ending.id} index={index} ways={paths.endingWays.get(ending.id) ?? 0}
            marked={marked.has(ending.id)} />
        ))}
      </ul>
    </div>
  )
}
