/**
 * @fileoverview Settings → Dimensions: the admin-defined axes reviews are
 * tagged with (product, module, user type …), each with a closed list of
 * values, an optional parent, and whether the model may infer it.
 *
 * Edits stay in a local draft until Save (one PUT of the whole list, validated
 * server-side); Discard returns to what is stored. A refused save leaves the
 * draft in place with the server's reason.
 *
 * @module components/DimensionsManager
 */
import { useTranslation } from 'react-i18next'
import { useQueryClient } from '@tanstack/react-query'
import DraftSaveBar from '../DraftSaveBar/DraftSaveBar'
import { DraftLoadGate } from '../DraftSaveBar/DraftParts'
import { useDraftEditor } from '../DraftSaveBar/useDraftEditor'
import { Plus } from 'lucide-react'
import { dimensionsApi, dimensionsConfigKey } from '../../api/dimensionsApi'
import { MAX_DIMENSIONS } from '../../api/dimensionsSchema'
import { useDimensionsConfig } from '../../hooks/useDimensions'
import DimensionEditor from './DimensionEditor'
import { draftProblem, newDimension, removeDimension, replaceDimension, toDraft, toWire } from './dimensionDraft'
import type { Dimension } from '../../api/dimensionsSchema'
import type { DraftDimension } from './dimensionDraft'

function DimensionsEditor({ stored }: Readonly<{ stored: readonly Dimension[] }>) {
  const { t } = useTranslation('components', { keyPrefix: 'dimensionsManager' })
  const queryClient = useQueryClient()
  const { draft, edit, barProps } = useDraftEditor({
    initial: (): DraftDimension[] => toDraft(stored),
    toWire,
    problem: draftProblem,
    save: (dimensions: Dimension[]) => dimensionsApi.saveConfig(dimensions),
    onSaved: (config) => queryClient.setQueryData(dimensionsConfigKey(), config),
  })

  return (
    <div className="space-y-4">
      {draft.length === 0 ? (
        <div className="text-center py-8 text-muted bg-bg-accent rounded-lg border border-dashed border-border-strong">
          <p className="mb-1">{t('emptyTitle')}</p>
          <p className="text-sm">{t('emptyHint')}</p>
        </div>
      ) : draft.map((dimension) => (
        <DimensionEditor
          key={dimension.uid}
          dimension={dimension}
          draft={draft}
          onChange={(next) => edit(replaceDimension(draft, dimension.uid, next))}
          onRemove={() => edit(removeDimension(draft, dimension.uid))}
        />
      ))}

      <button type="button" onClick={() => edit([...draft, newDimension()])} disabled={draft.length >= MAX_DIMENSIONS} className="btn btn-secondary">
        <Plus size={14} aria-hidden="true" /> {t('addDimension', { max: MAX_DIMENSIONS })}
      </button>

      <DraftSaveBar {...barProps} />
    </div>
  )
}

export default function DimensionsManager() {
  const { t } = useTranslation('components', { keyPrefix: 'dimensionsManager' })
  const { data, isLoading, isError } = useDimensionsConfig()
  return (
    <DraftLoadGate isLoading={isLoading} isError={isError} errorText={t('loadError')}>
      {/* Remounted when the stored config changes, so the draft restarts from it. */}
      <DimensionsEditor key={data?.updatedAt ?? 'none'} stored={data?.dimensions ?? []} />
    </DraftLoadGate>
  )
}
