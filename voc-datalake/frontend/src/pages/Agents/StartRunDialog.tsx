/**
 * @fileoverview "Start a run" of a saved engineering flow (`POST /agents/engineering/runs`, administrators): the
 * repository connection, the commit the run starts from, the repository's language and the run's goal, checked as
 * the server checks them, before anything is sent. The flow's monthly budget is the stored flow's,
 * never set here. On success the run monitor opens on the new run; a refusal (no image for the language, the hard cap
 * with nothing left of the month, a launch still under way) is said in the server's words.
 *
 * @module pages/Agents/StartRunDialog
 */
import { useId, useRef, useState } from 'react'
import { useMutation } from '@tanstack/react-query'
import { Link, useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { Loader2 } from 'lucide-react'
import ModalShell from '../../components/ModalShell/ModalShell'
import { LabeledField } from '../../components/LabeledField/LabeledField'
import { EnumSelectField } from '../../components/LabeledField/EnumSelectField'
import { engineeringRunsApi } from '../../api/engineeringRunsApi'
import { useActionError } from './engineeringRunText'
import { engineeringRunPagePath, flowRunsPath } from './workflowPaths'
import { MAX_RUN_GOAL, RUN_LANGUAGES, startOutcomeOf, startRunIssues, startRunRequest } from './startRunRules'
import type { RunLanguage, StartRunForm, StartRunIssues } from './startRunRules'
import type { WorkflowSummary } from '../../api/workflowsApi'

type TextKey = 'connection' | 'commit' | 'goal'
const FIELD_ORDER: readonly TextKey[] = ['connection', 'commit', 'goal']

function StartRunTextField({ field, value, issue, multiline = false, inputRef, onChange }: Readonly<{
  field: TextKey; value: string; issue: string | undefined; multiline?: boolean
  inputRef: (element: HTMLInputElement | HTMLTextAreaElement | null) => void; onChange: (value: string) => void
}>) {
  const { t } = useTranslation('agents')
  const hint = issue ?? t(`startRun.hints.${field}`)
  return (
    <LabeledField label={t(`startRun.fields.${field}`)} hint={hint} hintTone={issue === undefined ? 'muted' : 'danger'}>
      {(id) => {
        const shared = {
          id, ref: inputRef, value, 'aria-invalid': issue !== undefined, 'aria-describedby': `${id}-hint`,
          onChange: (event: { target: { value: string } }) => onChange(event.target.value),
        }
        return multiline
          ? <textarea {...shared} className="input w-full" rows={3} />
          : <input {...shared} className={field === 'commit' ? 'input w-full font-mono' : 'input w-full'}
              autoComplete="off" spellCheck={false} />
      }}
    </LabeledField>
  )
}

export function StartRunDialog({ workflow, onClose }: Readonly<{ workflow: WorkflowSummary; onClose: () => void }>) {
  const { t, i18n } = useTranslation('agents')
  const navigate = useNavigate()
  const errorText = useActionError()
  const titleId = useId()
  const [form, setForm] = useState<StartRunForm>({ connection: '', commit: '', language: 'python', goal: '' })
  const [issues, setIssues] = useState<StartRunIssues>({})
  const fields = useRef<Partial<Record<TextKey, HTMLInputElement | HTMLTextAreaElement | null>>>({})
  const start = useMutation({
    mutationFn: () => engineeringRunsApi.start(startRunRequest(workflow.workflow_id, form)),
    onSuccess: ({ runId }) => { void navigate(engineeringRunPagePath(runId)) },
  })
  const change = (field: keyof StartRunForm) => (value: string) => {
    setForm((current) => ({ ...current, [field]: value }))
    // (a field's message goes once it is changed; the next Start checks again)
    setIssues((current) => (field in current ? { ...current, [field]: undefined } : current))
  }
  const submit = () => {
    const found = startRunIssues(form)
    setIssues(found)
    const first = FIELD_ORDER.find((field) => found[field] !== undefined)
    if (first !== undefined) {
      fields.current[first]?.focus()
      return
    }
    start.mutate()
  }
  const issueText = (field: TextKey) => {
    const issue = issues[field]
    return issue === undefined ? undefined : t(`startRun.invalid.${issue}`, { max: MAX_RUN_GOAL })
  }
  // A failure after which a run was written or may have been (startOutcomeOf): it is opened or looked for, never
  // started again under a new id, so Start stays off.
  const outcome = start.isError ? startOutcomeOf(start.error) : null
  const mayExist = outcome !== null
  const budget = workflow.monthly_budget_usd === null ? null
    : new Intl.NumberFormat(i18n.language, { style: 'currency', currency: 'USD' }).format(workflow.monthly_budget_usd)
  return (
    <ModalShell isOpen onClose={onClose} ariaLabelledBy={titleId} panelClassName="w-full max-w-lg"
      dismissable={!start.isPending}>
      <div className="dialog-header">
        <div>
          <h2 id={titleId} className="dialog-title">{t('startRun.title', { name: workflow.name })}</h2>
          <p className="dialog-description">{t('startRun.description')}</p>
        </div>
      </div>
      <form className="contents" noValidate onSubmit={(event) => {
        event.preventDefault()
        if (!start.isPending && !mayExist) submit()
      }}>
        <div className="dialog-body space-y-3">
          {(['connection', 'commit'] as const).map((field) => (
            <StartRunTextField key={field} field={field} value={form[field]} issue={issueText(field)}
              inputRef={(element) => { fields.current[field] = element }} onChange={change(field)} />
          ))}
          <EnumSelectField<RunLanguage> label={t('startRun.fields.language')} hint={t('startRun.hints.language')}
            choices={RUN_LANGUAGES} value={form.language} display={(language) => t(`startRun.languages.${language}`)}
            onChange={(language) => setForm((current) => ({ ...current, language }))} />
          <StartRunTextField field="goal" value={form.goal} issue={issueText('goal')} multiline
            inputRef={(element) => { fields.current.goal = element }} onChange={change('goal')} />
          <p className="text-[12px] text-muted">
            {budget === null ? t('startRun.noBudget') : t('startRun.budget', { amount: budget })}
          </p>
          {start.isError && (
            <div role="alert" className="space-y-1 text-[12px] text-danger">
              <p>{outcome?.kind === 'unknown' ? t('startRun.mayHaveStarted') : errorText(start.error)}</p>
              {outcome?.kind === 'named' && (
                <Link className="link font-medium" to={engineeringRunPagePath(outcome.runId)}>{t('startRun.openRun')}</Link>
              )}
              {outcome?.kind === 'unknown' && (
                <Link className="link font-medium" to={flowRunsPath(workflow.workflow_id)}>{t('startRun.openRuns')}</Link>
              )}
            </div>
          )}
        </div>
        <div className="dialog-footer">
          <button type="button" className="btn btn-secondary" onClick={onClose} disabled={start.isPending}>
            {t('common.cancel')}
          </button>
          {/* (a run that may have been started is opened, never started again: Start stays off) */}
          <button type="submit" className="btn btn-primary" aria-disabled={start.isPending}
            disabled={mayExist}>
            {start.isPending && <Loader2 size={14} className="animate-spin" aria-hidden="true" />} {t('startRun.submit')}
          </button>
        </div>
      </form>
    </ModalShell>
  )
}
