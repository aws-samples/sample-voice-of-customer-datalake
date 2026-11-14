/**
 * @fileoverview The walkthrough editor beside a prototype's preview, for editors (docs/prototype-builder.md
 * Part 1): the version's steps, a new step by picking an element in the preview, reorder, text within the caps,
 * preview from any step, **Draft with the assistant** (steps land here, nothing saved), **Save** (a new version,
 * selected) and **Remove walkthrough** (a new version without it). A version written before walkthroughs existed
 * has no runtime in its preview: picking and previewing are off there, and the editor says so.
 * @module components/PrototypeWalkthrough/WalkthroughEditor
 */
import { useId, useState } from 'react'
import { useMutation } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { Crosshair, Loader2, Save, Wand2, X } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { HTTP_CONFLICT, apiErrorStatus } from '../../api/apiErrorStatus'
import { projectsApi } from '../../api/projectsApi'
import { useNewVersionWrite } from '../../pages/ProjectDetail/useVersionRestore'
import { WALKTHROUGH_LIMITS } from '../../api/prototypeWalkthroughSchema'
import type { WalkthroughStep } from '../../api/prototypeWalkthroughSchema'
import type { ProjectDocument } from '../../api/types'
import { refusalReason } from '../../lib/errors'
import type { WalkthroughHost } from '../PrototypePins/useWalkthroughHost'
import WalkthroughStepCard from './WalkthroughStepCard'
import { draftedSteps, firstProblem, moveStep, trimmedSteps, withPickedStep } from './walkthroughSteps'
import { useSavedWalkthrough } from './useSavedWalkthrough'
import type { EditorStep } from './walkthroughSteps'

interface WalkthroughEditorProps {
  readonly projectId: string
  readonly documentId: string
  readonly host: WalkthroughHost
  readonly onSaved: (document: ProjectDocument) => void
  readonly onClose: () => void
}

function useSaveWalkthrough(projectId: string, documentId: string, onSaved: (document: ProjectDocument) => void) {
  return useNewVersionWrite(projectId, (steps: readonly WalkthroughStep[], editId) =>
    projectsApi.savePrototypeWalkthrough(projectId, documentId, steps, editId), onSaved)
}

/** A failed save or draft in words: a 409 says the series moved; a refusal its reason; else try again. */
function failureText(save: { isError: boolean; error: unknown }, draft: { isError: boolean; error: unknown }, t: (key: string) => string): string | null {
  if (save.isError) {
    if (apiErrorStatus(save.error) === HTTP_CONFLICT) return t('prototypeWalkthrough.conflict')
    return refusalReason(save.error) ?? t('prototypeWalkthrough.saveFailed')
  }
  if (draft.isError) return refusalReason(draft.error) ?? t('prototypeWalkthrough.draftFailed')
  return null
}

/**
 * The editor's list: the saved steps until the editor changes them. A new pick (once per pick) re-points the
 * step being re-pointed, else adds a step.
 */
function useEditedSteps(saved: readonly WalkthroughStep[] | undefined, host: WalkthroughHost) {
  const [steps, setSteps] = useState<EditorStep[] | null>(null)
  const [target, setTarget] = useState<number | null>(null)
  const [lastPick, setLastPick] = useState(host.picked?.seq ?? 0)
  const { picked } = host
  if (picked !== null && picked.seq !== lastPick) {
    setLastPick(picked.seq)
    setSteps(withPickedStep(steps ?? saved ?? [], picked, target))
    setTarget(null)
  }
  const pickFor = (index: number | null) => {
    setTarget(index)
    host.pick()
  }
  return { steps, setSteps, list: steps ?? saved ?? [], pickFor }
}

export default function WalkthroughEditor({ projectId, documentId, host, onSaved, onClose }: WalkthroughEditorProps) {
  const { t, i18n } = useTranslation('components')
  const headingId = useId()
  const saved = useSavedWalkthrough(projectId, documentId)
  const { steps, setSteps, list, pickFor } = useEditedSteps(saved.data, host)
  const [notice, setNotice] = useState<string | null>(null)
  const save = useSaveWalkthrough(projectId, documentId, onSaved)
  const draft = useMutation({
    mutationFn: () => projectsApi.draftPrototypeWalkthrough(projectId, documentId, i18n.language === '' ? 'en' : i18n.language),
    onSuccess: (drafted) => {
      setSteps(draftedSteps(drafted))
      setNotice(t('prototypeWalkthrough.drafted'))
    },
  })
  const problem = firstProblem(list)
  const edit = (next: EditorStep[]) => {
    setSteps(next)
    setNotice(null)
  }
  const canPick = host.runtime && !host.picking
  const failure = failureText(save, draft, t)
  return (
    <section aria-labelledby={headingId} className="w-full lg:w-80 flex-shrink-0 flex flex-col gap-2 min-h-0 overflow-y-auto"
      data-testid="walkthrough-editor">
      <EditorHeader headingId={headingId} runtime={host.runtime} onClose={onClose} />
      <div className="flex flex-wrap gap-2">
        <button type="button" className="btn btn-secondary btn-sm" disabled={!canPick || list.length >= WALKTHROUGH_LIMITS.steps}
          onClick={() => { pickFor(null) }}>
          <Crosshair size={14} aria-hidden /> {t(host.picking ? 'prototypeWalkthrough.picking' : 'prototypeWalkthrough.addStep')}
        </button>
        <button type="button" className="btn btn-secondary btn-sm" disabled={draft.isPending} onClick={() => { draft.mutate() }}>
          <PendingIcon pending={draft.isPending} Icon={Wand2} />
          {t('prototypeWalkthrough.draft')}
        </button>
      </div>
      {notice === null ? null : <p role="status" className="text-xs text-info">{notice}</p>}
      <StepList list={list} onEdit={edit} canPick={canPick} onPick={pickFor}
        onPreview={host.runtime ? (index) => { host.preview(trimmedSteps(list), index) } : undefined} />
      {problem === null ? null : (
        <p className="text-xs text-muted">{t(`prototypeWalkthrough.problem.${problem.field}`, { n: problem.step })}</p>
      )}
      {failure === null ? null : <p role="alert" className="text-xs text-danger">{failure}</p>}
      <SaveRow canSave={steps !== null && problem === null && list.length > 0} pending={save.isPending}
        canRemove={(saved.data?.length ?? 0) > 0} onSave={() => { save.mutate(trimmedSteps(list)) }} onRemove={() => { save.mutate([]) }} />
    </section>
  )
}

/** The heading and Close; on a version without the runtime (written before 6.17.00), what to do instead. */
function EditorHeader({ headingId, runtime, onClose }: Readonly<{ headingId: string; runtime: boolean; onClose: () => void }>) {
  const { t } = useTranslation('components')
  return (
    <>
      <div className="flex items-center justify-between gap-2">
        <h3 id={headingId} className="text-sm font-semibold text-text-strong">{t('prototypeWalkthrough.heading')}</h3>
        <button type="button" className="icon-btn p-1" onClick={onClose} aria-label={t('prototypeWalkthrough.close')} title={t('prototypeWalkthrough.close')}>
          <X size={14} aria-hidden />
        </button>
      </div>
      {runtime ? null : <p className="text-xs text-warn">{t('prototypeWalkthrough.noRuntime')}</p>}
    </>
  )
}

function PendingIcon({ pending, Icon }: Readonly<{ pending: boolean; Icon: LucideIcon }>) {
  return pending ? <Loader2 size={14} className="animate-spin motion-reduce:animate-none" aria-hidden /> : <Icon size={14} aria-hidden />
}

/** The steps, each editable and movable (buttons, Alt+Shift+Up / Down, drag). */
function StepList({ list, onEdit, onPreview, canPick, onPick }: Readonly<{
  list: readonly EditorStep[]; onEdit: (next: EditorStep[]) => void; onPreview: ((index: number) => void) | undefined
  canPick: boolean; onPick: (index: number) => void
}>) {
  const { t } = useTranslation('components')
  const [dragFrom, setDragFrom] = useState<number | null>(null)
  if (list.length === 0) return <p className="text-xs text-muted">{t('prototypeWalkthrough.empty')}</p>
  return (
    <ol className="space-y-2">
      {list.map((step, index) => (
        <WalkthroughStepCard key={`${String(index)}:${step.selector ?? ''}`} step={step} index={index} total={list.length}
          onChange={(next) => { onEdit(list.map((s, i) => (i === index ? next : s))) }}
          onMove={(to) => { onEdit(moveStep(list, index, to)) }}
          onRemove={() => { onEdit(list.filter((_, i) => i !== index)) }}
          onPreview={() => { onPreview?.(index) }}
          onPick={canPick ? () => { onPick(index) } : undefined}
          onDragStart={() => { setDragFrom(index) }}
          onDrop={() => {
            if (dragFrom !== null) onEdit(moveStep(list, dragFrom, index))
            setDragFrom(null)
          }} />
      ))}
    </ol>
  )
}

function SaveRow({ canSave, pending, canRemove, onSave, onRemove }: Readonly<{
  canSave: boolean; pending: boolean; canRemove: boolean; onSave: () => void; onRemove: () => void
}>) {
  const { t } = useTranslation('components')
  return (
    <>
      <div className="flex flex-wrap gap-2">
        <button type="button" className="btn btn-primary btn-sm" disabled={!canSave || pending} onClick={onSave}>
          <PendingIcon pending={pending} Icon={Save} />
          {t('prototypeWalkthrough.save')}
        </button>
        {canRemove ? (
          <button type="button" className="btn btn-secondary btn-sm" disabled={pending} onClick={onRemove}>
            {t('prototypeWalkthrough.remove')}
          </button>
        ) : null}
      </div>
      <p className="text-xs text-muted">{t('prototypeWalkthrough.saveHint')}</p>
    </>
  )
}
