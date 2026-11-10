/**
 * @fileoverview Company → My objectives & KPIs (also Account → Objectives).
 *
 * Every user keeps their own objectives (each with KPIs: name, target, unit).
 * They feed that user's personal memory and the assistant, and never touch the
 * company objectives (`PUT /settings/my-context` is self-scoped server-side).
 *
 * Save checks the draft first (`validateMyContext`, the server's own rules): a
 * refused field is marked and explained in place, focus moves to the first one,
 * and no request is sent. A 400 the server still answers with a field path
 * (`objectives[0].kpis[0].target is required`) is shown on that field too, so
 * "Could not save. Try again." never stands alone for something a retry cannot fix.
 *
 * @module pages/Company/MyContextSection
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Plus, Target } from 'lucide-react'
import { companyContextApi, myContextBody, myContextKey } from '../../api/companyContextApi'
import type { MyContext, PersonalObjective } from '../../api/companyContextApi'
import { newClientId } from '../../api/schemaList'
import { SectionHeader } from './ContextParts'
import { DraftSaveRow, LoadedSection } from './SectionParts'
import { useDraft, useDraftGuard } from './useDraft'
import { PersonalObjectiveRow } from './MyContextRows'
import { serverFieldError, validateMyContext } from './myContextValidation'
import type { FieldErrors, ServerFieldProblem } from './myContextValidation'

const EMPTY: MyContext = { objectives: [] }
const MAX_PERSONAL_OBJECTIVES = 20
const NO_ERRORS: FieldErrors = new Map()

type ServerFieldError = ServerFieldProblem | null

function shownErrors(client: FieldErrors, attempted: boolean, server: ServerFieldError): FieldErrors {
  const shown = new Map(attempted ? client : NO_ERRORS)
  if (server !== null && !shown.has(server.key)) shown.set(server.key, server.problem)
  return shown
}

/** The draft, its save, and the field errors Save would raise or the server raised. */
function useMyContextForm() {
  const queryClient = useQueryClient()
  const query = useQuery({ queryKey: myContextKey(), queryFn: companyContextApi.getMyContext })
  const draft = useDraft<MyContext>(query.data ?? EMPTY, myContextBody)
  const [attempted, setAttempted] = useState(false)
  const [serverError, setServerError] = useState<ServerFieldError>(null)
  const save = useMutation({
    mutationFn: companyContextApi.saveMyContext,
    onMutate: () => setServerError(null),
    onError: (error, sent) => setServerError(serverFieldError(error, sent)),
    onSuccess: (saved) => {
      queryClient.setQueryData(myContextKey(), saved)
      draft.reset()
      setAttempted(false)
    },
  })
  const clientErrors = validateMyContext(draft.value)
  const update = (change: (current: MyContext) => MyContext) => { setServerError(null); draft.update(change) }
  /** Cancel: the saved objectives again, with no marked field and no failed save left over. */
  const discard = () => { draft.reset(); setAttempted(false); setServerError(null); save.reset() }
  return { query, draft, save, update, discard, clientErrors, attempted, setAttempted, serverError,
    errors: shownErrors(clientErrors, attempted, serverError) }
}

export default function MyContextSection() {
  const { t } = useTranslation('settings')
  const form = useMyContextForm()
  const { draft, save, update, clientErrors } = form
  const rowsRef = useRef<HTMLDivElement>(null)

  const objectives = draft.value.objectives
  const guard = useDraftGuard({
    dirty: draft.dirty, reset: draft.reset, save: () => save.mutateAsync(draft.value), canSave: clientErrors.size === 0,
  })
  const setObjective = (id: string, change: (o: PersonalObjective) => PersonalObjective) =>
    update((c) => ({ objectives: c.objectives.map((o) => (o.id === id ? change(o) : o)) }))
  const addObjective = () => update((c) => ({
    objectives: [...c.objectives, { id: newClientId('pobj'), title: '', description: '', due: undefined, kpis: [] }],
  }))
  const removeObjective = (id: string) => update((c) => ({ objectives: c.objectives.filter((o) => o.id !== id) }))
  const onSave = () => {
    if (clientErrors.size === 0) { save.mutate(draft.value); return }
    form.setAttempted(true)
    // After the render that marks the fields: focus the first refused one.
    requestAnimationFrame(() => rowsRef.current?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus())
  }
  const fieldsRefused = (form.attempted && clientErrors.size > 0) || form.serverError !== null

  return (
    <div className="card">
      <SectionHeader icon={Target} title={t('myContext.title')} description={t('myContext.description')} />
      <LoadedSection query={form.query}>
        {() => (
          <>
            {objectives.length === 0 ? <p className="text-sm text-muted italic mb-3">{t('myContext.empty')}</p> : null}
            <div className="space-y-3" ref={rowsRef}>
              {objectives.map((objective, index) => (
                <PersonalObjectiveRow
                  key={objective.id}
                  index={index}
                  objective={objective}
                  errors={form.errors}
                  onChange={(change) => setObjective(objective.id, change)}
                  onRemove={() => removeObjective(objective.id)}
                />
              ))}
            </div>
            <button
              type="button"
              onClick={addObjective}
              disabled={objectives.length >= MAX_PERSONAL_OBJECTIVES}
              className="btn btn-secondary btn-sm flex items-center gap-1.5 mt-3"
            >
              <Plus size={14} /> {t('myContext.addObjective')}
            </button>
            <DraftSaveRow save={save} dirty={draft.dirty} onSave={onSave}
              onDiscard={form.discard}
              failedLabel={fieldsRefused ? t('myContext.fixFields') : undefined} />
          </>
        )}
      </LoadedSection>
      {guard.dialog}
    </div>
  )
}
