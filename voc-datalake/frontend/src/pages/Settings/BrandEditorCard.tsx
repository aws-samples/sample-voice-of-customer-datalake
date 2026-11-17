/**
 * @fileoverview A brand form in a card of its own, with its own Save: Administration → Brand & appearance's brand, a
 * workspace's brand on its settings page, and the deployment's default brand on Platform. The caller passes the stored
 * brand's query, the drafts (`useBrandDraft` or `useBrandForm`), whether the caller may save, and the save; a refusal
 * is said in words (`refusals`). After a save the server accepted it says "Saved" until the next edit (the one Saved
 * pattern, components/SavedStatus); with `shouldBlock`, leaving with an unsaved edit asks first.
 *
 * @module pages/Settings/BrandEditorCard
 */
import type { ReactNode } from 'react'
import type { Location } from 'react-router-dom'
import { useMutation } from '@tanstack/react-query'
import SavedStatus from '../../components/SavedStatus/SavedStatus'
import StickyActionBar from '../../components/StickyActionBar/StickyActionBar'
import { useUnsavedChangesGuard } from '../../components/UnsavedChangesGuard/useUnsavedChangesGuard'
import { useConfigStore } from '../../store/configStore'
import type { BrandSettingsPayload } from '../../api/brandApi'
import RefusalAlert from '../../workspace/RefusalAlert'
import type { Refusal } from '../../workspace/workspaceRefusals'
import { QueryState } from '../Company/ContextParts'
import { BrandFields, BrandReadOnlyNotice, BrandSyncStatus, SaveButtonContent } from './SettingsSections'
import type { BrandFieldValues } from './SettingsSections'
import { brandPayload } from './useSettingsSync'
import type { BrandFields as BrandFieldTexts } from './useSettingsSync'
import { SECTION_TITLE } from './sectionTitle'

/** The stored brand's query, as the card shows its state. */
interface BrandLoad {
  readonly isLoading: boolean
  readonly isError: boolean
  readonly refetch: () => unknown
}

/** The drafts the card edits: the four fields, their setters, and the reference a save moves. */
interface BrandDraft extends BrandFieldValues {
  readonly fields: BrandFieldTexts
  readonly dirty: boolean
  readonly markSaved: () => void
  readonly discard: () => void
}

interface BrandEditorCardProps {
  readonly title: string
  readonly description?: ReactNode
  readonly idPrefix: string
  readonly load: BrandLoad
  readonly draft: BrandDraft
  /** Whether the caller may save (a hint: the server decides); false shows the fields read-only with `readOnlyNotice`. */
  readonly canEdit: boolean
  readonly readOnlyNotice: string
  readonly save: (payload: BrandSettingsPayload) => Promise<unknown>
  /** After a save the server accepted: refresh what reads the brand. */
  readonly onSaved: () => Promise<unknown>
  readonly refusals: readonly Refusal[]
  /** Which moves lose the draft (the unsaved-changes guard asks before them); absent: no guard. */
  readonly shouldBlock?: (current: Location, next: Location) => boolean
}

const NEVER = () => false

export default function BrandEditorCard({
  title, description, idPrefix, load, draft, canEdit, readOnlyNotice, save, onSaved, refusals, shouldBlock,
}: BrandEditorCardProps) {
  const apiEndpoint = useConfigStore((state) => state.config.apiEndpoint)
  const mutation = useMutation({
    mutationFn: save,
    onSuccess: async () => {
      draft.markSaved()
      await onSaved()
    },
  })
  const saveDraft = async () => {
    await mutation.mutateAsync(brandPayload(draft.fields))
    return true
  }
  const guard = useUnsavedChangesGuard({
    dirty: canEdit && shouldBlock !== undefined && draft.dirty, onSave: saveDraft, onDiscard: draft.discard,
    shouldBlock: shouldBlock ?? NEVER,
  })
  const titleId = `${idPrefix}-title`

  return (
    <section className="card space-y-4" aria-labelledby={titleId}>
      {guard.dialog}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 id={titleId} className={SECTION_TITLE}>{title}</h2>
        <BrandSyncStatus apiEndpoint={apiEndpoint} loadingSettings={load.isLoading} loadFailed={load.isError} />
      </div>
      {description === undefined ? null : <p className="text-sm text-muted">{description}</p>}
      {apiEndpoint ? <QueryState isLoading={load.isLoading} isError={load.isError} onRetry={() => void load.refetch()} /> : null}
      {canEdit ? null : <BrandReadOnlyNotice text={readOnlyNotice} />}
      <BrandFields values={draft} readOnly={!canEdit} idPrefix={idPrefix} />
      <RefusalAlert error={mutation.error} refusals={refusals} />
      {canEdit ? (
        <StickyActionBar variant="inline" className="flex flex-col gap-2 py-2 sm:flex-row sm:items-center sm:justify-end">
          <SavedStatus saved={mutation.isSuccess && !draft.dirty} />
          <button type="button" className="btn btn-primary flex items-center justify-center gap-2" disabled={mutation.isPending}
            onClick={() => mutation.mutate(brandPayload(draft.fields))}>
            <SaveButtonContent saving={mutation.isPending} />
          </button>
        </StickyActionBar>
      ) : null}
    </section>
  )
}
