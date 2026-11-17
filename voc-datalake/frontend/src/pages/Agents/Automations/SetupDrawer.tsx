/**
 * @fileoverview The Set up drawer of an engineering automation (7.52.00 C1; ux-agents-redesign part 1 §2.4 and part 2
 * S5): the app's one `SideSheet` at the inline end, so the row that opened it stays in view, whatever its height. One
 * drawer serves the Automations list, the automation's page and the setup guide's steps (useSetupDrawer.tsx).
 *
 * - **① Repository:** the connection it works on, `owner/name` first (with a GitHub issue trigger only GitHub ones);
 *   with one it can use, that repository as text and a way to Connections. **② Language**, **③ Monthly budget**
 *   (`$`, prefilled from its flow: a seeded flow has one), saved on the flow as a new revision only when changed.
 * - **④ Before it can run** (DrawerReadiness.tsx): the readiness of the selection, read again whenever it changes.
 *   Opened from "N to fix", the drawer puts the focus on that heading.
 * - **The footer:** while a check holds Enable, **Save** stores the connection and the language without enabling it
 *   ("Enable waits for N fixes"); when nothing holds it, **Save and enable**; **Save** for an automation already on. A
 *   refused Enable (409) lists the checks it names.
 *
 * The drawer moves the focus to its first field, closes on Escape except while saving, and gives the focus back to
 * what opened it (SideSheet, ModalShell).
 *
 * @module pages/Agents/Automations/SetupDrawer
 */
import { useEffect, useId, useRef } from 'react'
import { Link } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { Loader2, Wrench } from 'lucide-react'
import { ENGINEERING_MAX_MONTHLY_BUDGET_USD } from '@stream/assistant/tools/agent-limits'
import SideSheet from '../../../components/SideSheet/SideSheet'
import { failingChecksOf } from '../../../api/engineeringReadinessApi'
import { serverReason } from '../../../lib/errors'
import { agentsPath } from '../agentsPaths'
import { FailingChecks } from '../ReadinessChecks'
import { RUN_LANGUAGES } from '../startRunRules'
import { DrawerReadiness, StepTitle } from './DrawerReadiness'
import { useSetupDrawerForm } from './useSetupDrawerForm'
import type { SetupForm } from './useSetupDrawerForm'
import type { ReactNode, RefObject } from 'react'
import type { Agent } from '../../../api/agentsApi'
import type { EngineeringConnection } from '../../../api/engineeringConnectionsApi'

/** Where the focus goes as the drawer opens: its first field, or its readiness heading ("N to fix"). */
export type DrawerFocus = 'fields' | 'readiness'

/** A numbered step's field: its label (the number, then the words) wired to its control, and a hint under it. */
function StepField({ n, label, hint, hintTone = 'muted', children }: Readonly<{
  n: number; label: string; hint?: string; hintTone?: 'muted' | 'danger'; children: (id: string) => ReactNode
}>) {
  const id = useId()
  return (
    <div className="space-y-1">
      <label htmlFor={id} className="block text-[12px] font-medium text-muted"><StepTitle n={n}>{label}</StepTitle></label>
      {children(id)}
      {hint !== undefined && <p id={`${id}-hint`} className={hintTone === 'danger' ? 'text-[12px] text-danger' : 'text-[12px] text-muted'}>{hint}</p>}
    </div>
  )
}

/** ① The repository: one it can use as text (and the way to Connections), several in a select, `owner/name` first. */
function RepositoryField({ form, connections, fieldRef, onChange }: Readonly<{
  form: SetupForm; connections: readonly EngineeringConnection[]; fieldRef: RefObject<HTMLSelectElement | null>
  onChange: (connection: string) => void
}>) {
  const { t } = useTranslation('agents')
  if (connections.length < 2) {
    return (
      <div className="space-y-1">
        <p className="text-[12px] font-medium text-muted"><StepTitle n={1}>{t('automations.drawer.repository')}</StepTitle></p>
        <p className="flex flex-wrap items-baseline gap-x-3 text-sm text-text-strong break-words [overflow-wrap:anywhere]">
          {connections.at(0)?.repository ?? t('automations.drawer.noRepository')}
          <Link className="link text-[12px]" to={agentsPath({ view: 'connections' })}>{t('automations.drawer.changeRepository')}</Link>
        </p>
      </div>
    )
  }
  const twice = (repository: string) => connections.filter((connection) => connection.repository === repository).length > 1
  return (
    <StepField n={1} label={t('automations.drawer.repository')} hint={t('engineeringAgent.connectionHint')}>
      {(id) => (
        <select ref={fieldRef} id={id} className="select w-full" value={form.connection} onChange={(e) => onChange(e.target.value)}>
          {connections.map((connection) => (
            <option key={connection.connection_id} value={connection.connection_id}>
              {twice(connection.repository) ? `${connection.repository} (${connection.connection_id})` : connection.repository}
            </option>
          ))}
        </select>
      )}
    </StepField>
  )
}

/** ② and ③: the language and the monthly budget (`$`). */
function LanguageAndBudget({ form, budgetIssue, fieldRef, onChange }: Readonly<{
  form: SetupForm; budgetIssue: boolean; fieldRef: RefObject<HTMLSelectElement | null> | undefined
  onChange: (field: 'language' | 'budget', value: string) => void
}>) {
  const { t } = useTranslation('agents')
  return (
    <>
      <StepField n={2} label={t('automations.drawer.language')} hint={t('startRun.hints.language')}>
        {(id) => (
          <select ref={fieldRef} id={id} className="select w-full" value={form.language} onChange={(e) => onChange('language', e.target.value)}>
            {RUN_LANGUAGES.map((language) => <option key={language} value={language}>{t(`startRun.languages.${language}`)}</option>)}
          </select>
        )}
      </StepField>
      <StepField n={3} label={t('automations.drawer.budget')}
        hint={budgetIssue ? t('engineeringAgent.budgetInvalid') : t('engineeringAgent.budgetHint')}
        hintTone={budgetIssue ? 'danger' : 'muted'}>
        {(id) => (
          <div className="relative">
            <span className="pointer-events-none absolute inset-y-0 start-3 flex items-center text-sm text-muted" aria-hidden="true">$</span>
            <input id={id} type="number" inputMode="decimal" min={0.01} step={0.01} max={ENGINEERING_MAX_MONTHLY_BUDGET_USD}
              className="input w-full ps-6 tabular-nums" value={form.budget} aria-invalid={budgetIssue || undefined}
              aria-describedby={`${id}-hint`} onChange={(e) => onChange('budget', e.target.value)} />
          </div>
        )}
      </StepField>
    </>
  )
}

/** The refusal of a save or an Enable: the failing checks a 409 names, else the server's words. */
function SaveError({ error }: Readonly<{ error: unknown }>) {
  const { t } = useTranslation('agents')
  const failing = failingChecksOf(error)
  if (failing !== null && failing.length > 0) return <FailingChecks checks={failing} />
  return <p role="alert" className="text-[12px] text-danger">{serverReason(error) ?? t('engineeringAgent.setupFailed')}</p>
}

/** The footer: why Enable waits, Cancel, and Save / Save and enable (the form's submit, by its id). */
function DrawerFooter({ formId, held, enable, valid, pending, onClose }: Readonly<{
  formId: string; held: number; enable: boolean; valid: boolean; pending: boolean; onClose: () => void
}>) {
  const { t } = useTranslation('agents')
  return (
    <>
      <p role="status" className="text-[12px] text-warn">{held > 0 ? t('automations.drawer.enableWaits', { count: held }) : ''}</p>
      <div className="flex gap-2">
        <button type="button" className="btn btn-secondary" disabled={pending} onClick={onClose}>{t('common.cancel')}</button>
        <button type="submit" form={formId} className="btn btn-primary" disabled={!valid || pending}>
          {pending && <Loader2 size={14} className="animate-spin" aria-hidden="true" />}
          {enable ? t('engineeringAgent.saveAndEnable') : t('engineeringAgent.save')}
        </button>
      </div>
    </>
  )
}

interface SetupDrawerProps {
  readonly agent: Agent
  readonly focus: DrawerFocus
  readonly onClose: () => void
  /** After a save the server accepted: the automation as saved, and whether it was enabled by it. */
  readonly onSaved: (saved: Agent, enabled: boolean) => void
}

/** The drawer (module doc), open while mounted. */
export function SetupDrawer({ agent, focus, onClose, onSaved }: SetupDrawerProps) {
  const { t } = useTranslation('agents')
  const formId = useId()
  const fieldRef = useRef<HTMLSelectElement | null>(null)
  const headingRef = useRef<HTMLHeadingElement | null>(null)
  const drawer = useSetupDrawerForm(agent, onSaved)
  const { form, connections, save } = drawer
  const loaded = form !== null
  // (in the component that renders the sheet, so it runs after ModalShell's own focus on open)
  useEffect(() => {
    if (loaded) (focus === 'readiness' ? headingRef.current : fieldRef.current)?.focus()
  }, [loaded, focus])
  return (
    <SideSheet isOpen onClose={onClose} dismissable={!save.isPending} icon={Wrench}
      title={t('engineeringAgent.setupTitle', { name: agent.name })} description={t('automations.drawer.description')}
      footer={<DrawerFooter formId={formId} held={drawer.heldBy ?? 0} enable={drawer.enable} valid={drawer.valid}
        pending={save.isPending} onClose={onClose} />}>
      <DrawerLoading loaded={loaded} failed={drawer.failed} />
      {form !== null && connections !== undefined && (
        <>
          <form id={formId} className="space-y-5" noValidate onSubmit={(event) => { event.preventDefault(); drawer.submit() }}>
            <RepositoryField form={form} connections={connections} fieldRef={fieldRef} onChange={(value) => drawer.change('connection', value)} />
            <LanguageAndBudget form={form} budgetIssue={drawer.budgetIssue} fieldRef={connections.length > 1 ? undefined : fieldRef}
              onChange={drawer.change} />
          </form>
          <DrawerReadiness subject={drawer.subject} headingRef={headingRef} />
          {save.isError && <SaveError error={save.error} />}
        </>
      )}
    </SideSheet>
  )
}

/** The drawer's state while its reads load or after one failed. */
function DrawerLoading({ loaded, failed }: Readonly<{ loaded: boolean; failed: boolean }>) {
  const { t } = useTranslation('agents')
  if (loaded) return null
  return failed
    ? <p role="alert" className="text-[12px] text-danger">{t('engineeringAgent.loadFailed')}</p>
    : <div className="skeleton h-40" role="status" aria-label={t('engineeringAgent.loading')} />
}
