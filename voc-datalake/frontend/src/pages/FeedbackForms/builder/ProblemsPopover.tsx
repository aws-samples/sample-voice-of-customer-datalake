/**
 * @fileoverview The header's problems chip (UX §3.1): "✕ N problems" (`badge-danger`) while errors block Save or
 * Publish (an unreadable theme blocks only Publish, and its row says that Save still works),
 * "▲ N warnings" (`badge-warn`) when only warnings are left, nothing when the form is clean. It opens a list of
 * every problem ("Q4 · This rule goes to a question that was deleted.") with **Go to**, which selects the card,
 * and the server's own refusals of the last save under "Other problems".
 *
 * @module pages/FeedbackForms/builder/ProblemsPopover
 */
import { useEffect, useId, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { AlertTriangle, CircleX } from 'lucide-react'
import clsx from 'clsx'
import type { FormProblem } from '../model/validateForm'
import { useDraft } from './formDraftContext'
import { useBuilderUi } from './builderUi'
import { OPEN_PROBLEMS_EVENT, goToProblem, problemMessage, problemPlace } from './problemText'
import { noCleanup } from '../../../hooks/noCleanup'

function ProblemItem({ problem, onGo }: Readonly<{ problem: FormProblem; onGo: () => void }>) {
  const { t } = useTranslation('feedbackForms')
  const { form } = useDraft()
  const Icon = problem.severity === 'error' ? CircleX : AlertTriangle
  return (
    <li className="flex items-start gap-2 py-1.5">
      <Icon size={14} aria-hidden="true" className={clsx('mt-0.5 shrink-0', problem.severity === 'error' ? 'text-danger' : 'text-warn')} />
      <p className="min-w-0 flex-1 text-[13px] text-text">
        <span className="font-medium text-text-strong">{problemPlace(t, form, problem.at)}</span>
        {' · '}{problemMessage(t, problem)}
        {problem.blocks === 'publish' && <span className="text-muted">{' '}{t('problems.blocksPublishOnly')}</span>}
      </p>
      <button type="button" className="btn btn-ghost btn-sm shrink-0" onClick={onGo}>{t('problems.goTo')}</button>
    </li>
  )
}

export default function ProblemsPopover() {
  const { t } = useTranslation('feedbackForms')
  // Every error counts as one, an unreadable theme's too (it blocks Publish, though Save still works).
  const { problems, publishErrors: errors, serverErrors } = useDraft()
  const ui = useBuilderUi()
  const [open, setOpen] = useState(false)
  const panelId = useId()
  const trigger = useRef<HTMLButtonElement>(null)
  const listed = problems.filter((problem) => problem.severity !== 'note')
  const warnings = listed.length - errors.length

  // "Show problems" elsewhere in the builder (openProblemsList): open the list, focus on its chip.
  useEffect(() => {
    const onOpen = () => {
      setOpen(true)
      trigger.current?.focus()
    }
    window.addEventListener(OPEN_PROBLEMS_EVENT, onOpen)
    return () => window.removeEventListener(OPEN_PROBLEMS_EVENT, onOpen)
  }, [])

  useEffect(() => {
    if (!open) return noCleanup
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      setOpen(false)
      trigger.current?.focus()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open])

  if (listed.length === 0 && serverErrors.length === 0) return null
  const blocking = errors.length > 0 || serverErrors.length > 0
  return (
    <div className="relative">
      <button ref={trigger} type="button" aria-expanded={open} aria-controls={panelId} onClick={() => setOpen((now) => !now)}
        className={clsx('badge inline-flex items-center gap-1 focus-ring', blocking ? 'badge-danger' : 'badge-warn')}>
        {blocking ? <CircleX size={12} aria-hidden="true" /> : <AlertTriangle size={12} aria-hidden="true" />}
        {blocking ? t('problems.count', { count: errors.length + serverErrors.length }) : t('problems.warnings', { count: warnings })}
      </button>
      {open && (
        <div id={panelId} role="region" aria-label={t('problems.listLabel')}
          className="menu absolute left-0 top-full z-30 mt-1 max-h-[60vh] w-[min(28rem,90vw)] overflow-auto p-3 animate-scale-in">
          <ul className="divide-y divide-border">
            {listed.map((problem, index) => (
              <ProblemItem key={`${problem.code}-${String(index)}`} problem={problem}
                onGo={() => { setOpen(false); goToProblem(ui, problem.at) }} />
            ))}
          </ul>
          {serverErrors.length > 0 && (
            <div className="mt-2 border-t border-border pt-2">
              <p className="text-[11px] font-semibold uppercase tracking-[.08em] text-muted-strong">{t('problems.otherProblems')}</p>
              <ul className="mt-1 space-y-1">
                {serverErrors.map((error) => <li key={error.message} className="text-[13px] text-danger">{error.message}</li>)}
              </ul>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
