/**
 * @fileoverview The forms builder (UX §3): a full page with the header, the banners (a stale save, a migrated v1
 * form, D15's language prompt, the AI draft) and the tabs, over ONE draft of the form (formDraftContext.ts).
 *
 * A stored form is read from `GET /feedback-forms/{id}`; an unsaved new one comes in the history state
 * (newFormHandoff.ts) and, without one, the page goes to the picker. The first Save of a new form replaces `new`
 * in the address with its id and keeps the same draft. Switching tabs keeps the edits; leaving the form asks first
 * (the unsaved-changes guard), except for a leave the person already confirmed (`BuilderUi.leave`).
 *
 * @module pages/FeedbackForms/builder/FormBuilderPage
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { Navigate, useLocation, useNavigate } from 'react-router-dom'
import type { Location } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import clsx from 'clsx'
import { Info } from 'lucide-react'
import LoadFailed from '../../../components/LoadFailed/LoadFailed'
import { useUnsavedChangesGuard } from '../../../components/UnsavedChangesGuard/useUnsavedChangesGuard'
import { feedbackFormsV2Api } from '../../../api/feedbackFormsV2Api'
import type { LoadedForm } from '../model/formsV2'
import { FormDraftContext } from './formDraftContext'
import type { FormDraft } from './formDraftContext'
import { BuilderUiContext } from './builderUi'
import type { BuilderUi } from './builderUi'
import { useFormDraft } from './useFormDraft'
import { builderPath, pickerPath } from './builderPaths'
import type { BuilderTab } from './builderPaths'
import { readHandoff } from './newFormHandoff'
import { defaultBuilderTab } from './tabState'
import type { NewFormHandoff } from './newFormHandoff'
import BuilderHeader, { BackToForms, BuilderActionBar } from './BuilderHeader'
import BuilderTabs from './BuilderTabs'
import ConflictBanner from './ConflictBanner'
import AiDraftBanner from '../ai/AiDraftBanner'
import ImproveSheet from '../ai/ImproveSheet'
import LanguageConfirmNotice from '../tabs/LanguageConfirmNotice'
import QuestionsTab from '../questions/QuestionsTab'
import { MEDIUM, useMedia } from '../questions/useMedia'
import PreviewWindowProvider from '../preview/PreviewWindowProvider'
import FlowTab from '../logic/FlowTab'
import LanguagesTab from '../tabs/LanguagesTab'
import HiddenFieldsTab from '../tabs/HiddenFieldsTab'
import TestTab from '../tabs/TestTab'
import ShareTab from '../tabs/ShareTab'
import ResultsTab from '../results/ResultsTab'
import SettingsTab from '../tabs/SettingsTab'

/** The active tab's content: a switch over the tab (the address's, checked by builderPaths.ts), never a method read off
 * an object by a name from the address. */
function TabContent({ tab }: Readonly<{ tab: BuilderTab }>): ReactNode {
  switch (tab) {
    case 'questions': return <QuestionsTab />
    case 'flow': return <FlowTab />
    case 'languages': return <LanguagesTab />
    case 'hidden-fields': return <HiddenFieldsTab />
    case 'test': return <TestTab />
    case 'share': return <ShareTab />
    case 'results': return <ResultsTab />
    case 'settings': return <SettingsTab />
  }
}

/** The one-time notice of a migrated v1 form (UX §3.6), until its first save. */
function MigratedNotice({ draft }: Readonly<{ draft: FormDraft }>) {
  const { t } = useTranslation('feedbackForms')
  if (draft.meta?.migrated_from_v1 !== true || draft.status.kind === 'saved') return null
  return (
    <p role="note" className="flex items-start gap-2 rounded-lg border border-info/30 bg-info-subtle p-3 text-sm text-text">
      <Info size={16} className="mt-0.5 shrink-0 text-info" aria-hidden="true" />
      {t('builder.migrated')}
    </p>
  )
}

interface SessionProps {
  readonly loaded: LoadedForm | null
  readonly handoff: NewFormHandoff | null
  readonly tab: BuilderTab | null
  readonly rest: readonly string[]
  readonly onCreated: (formId: string) => void
  readonly formId: string | null
}

function BuilderSession({ loaded, handoff, tab, rest, onCreated, formId }: SessionProps) {
  const navigate = useNavigate()
  const leaving = useRef(false)
  const [improving, setImproving] = useState(false)
  const draft = useFormDraft({ loaded, handoff, onCreated: (id) => { leaving.current = true; onCreated(id) } })
  const ref = formId ?? 'new'
  const shouldBlock = useCallback((_current: Location, next: Location) =>
    !leaving.current && !next.pathname.startsWith(`/feedback-forms/${encodeURIComponent(ref)}/`), [ref])
  const guard = useUnsavedChangesGuard({ dirty: draft.dirty, onSave: draft.save, canSave: draft.errors.length === 0, shouldBlock })
  useEffect(() => { leaving.current = false }, [formId])

  const ui = useMemo<BuilderUi>(() => ({
    formId,
    rest,
    go: (next, segments = [], options = {}) => { void navigate(builderPath(formId, next, ...segments), { replace: options.replace === true }) },
    openImprove: () => setImproving(true),
    leave: (path, state) => { leaving.current = true; void navigate(path, { state }) },
  }), [formId, rest, navigate])

  const active = tab ?? defaultBuilderTab(draft)
  const medium = useMedia(MEDIUM)
  useEffect(() => {
    if (tab === null) void navigate(builderPath(formId, active), { replace: true })
  }, [tab, active, formId, navigate])

  // From lg the Questions tab's panes scroll on their own: the builder is then as tall as the page's scroller, its
  // tab body takes what the header and banners leave, and the page itself does not scroll (forms audit F9). Every
  // other tab, and the Questions tab on a narrow screen, scrolls with the page as before.
  const fullHeight = active === 'questions' && medium
  return (
    <FormDraftContext.Provider value={draft}>
      <BuilderUiContext.Provider value={ui}>
        <PreviewWindowProvider form={draft.form} formKey={ref}>
          <div className={clsx('space-y-4', fullHeight && 'flex h-full min-h-[36rem] flex-col')}>
            <BuilderHeader />
            <ConflictBanner />
            <MigratedNotice draft={draft} />
            <LanguageConfirmNotice />
            <AiDraftBanner />
            <BuilderTabs active={active} onSelect={(next) => ui.go(next)} />
            <div className={clsx(fullHeight && 'min-h-0 flex-1')}><TabContent tab={active} /></div>
            <BuilderActionBar />
          </div>
          <ImproveSheet isOpen={improving} onClose={() => setImproving(false)} />
          {guard.dialog}
        </PreviewWindowProvider>
      </BuilderUiContext.Provider>
    </FormDraftContext.Provider>
  )
}

/** The builder of a stored form: read it, then edit it. */
function StoredFormBuilder({ formId, tab, rest }: Readonly<{ formId: string; tab: BuilderTab | null; rest: readonly string[] }>) {
  const { t } = useTranslation('feedbackForms')
  const query = useQuery({ queryKey: ['feedback-form-v2', formId], queryFn: () => feedbackFormsV2Api.getForm(formId), staleTime: Infinity, retry: false })
  if (query.isError) {
    return (
      <div className="space-y-4">
        <BackToForms />
        <LoadFailed onRetry={() => void query.refetch()} retrying={query.isFetching} message={t('builder.loadFailed')} />
      </div>
    )
  }
  if (query.data === undefined) return <p role="status" className="text-sm text-muted">{t('builder.loading')}</p>
  return <BuilderSession key={formId} loaded={query.data} handoff={null} tab={tab} rest={rest} formId={formId} onCreated={storedFormIsNeverCreated} />
}

function storedFormIsNeverCreated(): void {
  // (only a new form is created by its first save)
}

export default function FormBuilderPage({ formId, tab, rest }: Readonly<{ formId: string | null; tab: BuilderTab | null; rest: readonly string[] }>) {
  const location = useLocation()
  const navigate = useNavigate()
  // The new form this page created: its address now has an id, and it keeps the draft it has (no re-read).
  const [created, setCreated] = useState<string | null>(null)
  const [handoff] = useState(() => readHandoff(location.state))
  const onCreated = useCallback((id: string) => {
    setCreated(id)
    // (`/feedback-forms/new/<tab>/…` → `/feedback-forms/<id>/<tab>/…`: the same tab and selection)
    const segments = location.pathname.split('/').filter((segment) => segment !== '').slice(2)
    void navigate(`/feedback-forms/${encodeURIComponent(id)}/${segments.join('/')}`, { replace: true })
  }, [location.pathname, navigate])

  if (formId !== null && formId !== created) return <StoredFormBuilder formId={formId} tab={tab} rest={rest} />
  if (handoff === null) return <Navigate to={pickerPath()} replace />
  return <BuilderSession key="new" loaded={null} handoff={handoff} tab={tab} rest={rest} formId={formId} onCreated={onCreated} />
}
