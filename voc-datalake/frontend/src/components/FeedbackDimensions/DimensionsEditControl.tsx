/**
 * @fileoverview "Edit dimensions" for one review — mirrors the "Change
 * category" control: shown wherever that one is, and the route is the
 * enforcement (404 when the review is not visible to the caller, 409 when it
 * changed meanwhile).
 *
 * Only what changed is sent: a dimension set to a new value, a dimension
 * cleared (`null`), and the tags list when it differs. A value set here is
 * recorded as hand-set, so a later re-inference never overwrites it.
 *
 * @module components/FeedbackDimensions/DimensionsEditControl
 */
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { AlertCircle, Check, Layers, Loader2 } from 'lucide-react'
import { dimensionsApi, dimensionsEditErrorKey, invalidateAfterDimensionsChange } from '../../api/dimensionsApi'
import { useDimensionsConfig } from '../../hooks/useDimensions'
import DimensionValuesFields from '../DimensionFields/DimensionValuesFields'
import TagsField from '../DimensionFields/TagsField'
import StickyActionBar from '../StickyActionBar/StickyActionBar'
import type { FeedbackDimensionsChange } from '../../api/dimensionsApi'
import { dimensionsChange } from './feedbackDimensions'
import type { EditableFeedback } from './feedbackDimensions'
import type { Dimension } from '../../api/dimensionsSchema'

function EditForm({ feedback, onClose }: Readonly<{ feedback: EditableFeedback; onClose: () => void }>) {
  const { data, isLoading } = useDimensionsConfig()
  if (isLoading) return <Loader2 size={14} className="animate-spin text-muted" aria-hidden="true" />
  return <EditFields feedback={feedback} dimensions={data?.dimensions ?? []} onClose={onClose} />
}

function EditFields({ feedback, dimensions, onClose }: Readonly<{ feedback: EditableFeedback; dimensions: readonly Dimension[]; onClose: () => void }>) {
  const { t } = useTranslation('components', { keyPrefix: 'feedbackDimensions' })
  const { t: tAll } = useTranslation()
  const queryClient = useQueryClient()
  const [values, setValues] = useState<Record<string, string>>(() => ({ ...feedback.dimensions }))
  const [tags, setTags] = useState<string[]>(() => [...(feedback.tags ?? [])])
  const [tagsValid, setTagsValid] = useState(true)
  const save = useMutation({
    mutationFn: (change: FeedbackDimensionsChange) => dimensionsApi.setFeedbackDimensions(feedback.feedback_id, change),
    onSuccess: () => {
      void invalidateAfterDimensionsChange(queryClient)
      onClose()
    },
  })
  const change = dimensionsChange(dimensions, feedback, { dimensions: values, tags })

  return (
    <div className="flex flex-col gap-2 rounded-md border border-border bg-bg-accent p-2 sm:p-3 w-full">
      <DimensionValuesFields dimensions={dimensions} value={values} onChange={setValues} emptyLabel={t('none')} selectClassName="select select-sm w-full" />
      <TagsField tags={tags} onChange={setTags} onValidityChange={setTagsValid} />
      {save.isError && (
        <p role="alert" className="text-xs text-danger flex items-center gap-1">
          <AlertCircle size={12} aria-hidden="true" /> {tAll(dimensionsEditErrorKey(save.error))}
        </p>
      )}
      <StickyActionBar variant="inline" className="flex justify-end gap-2 py-2">
        <button type="button" onClick={onClose} className="btn btn-secondary btn-sm">{t('cancel')}</button>
        <button
          type="button"
          onClick={() => { if (change !== null) save.mutate(change) }}
          disabled={change === null || !tagsValid || save.isPending}
          className="btn btn-primary btn-sm"
        >
          {save.isPending ? <Loader2 size={14} className="animate-spin" aria-hidden="true" /> : <Check size={14} aria-hidden="true" />}
          {t('save')}
        </button>
      </StickyActionBar>
    </div>
  )
}

/** The "Edit dimensions" trigger; expands into the editor in place. */
export default function DimensionsEditControl({ feedback }: Readonly<{ feedback: EditableFeedback }>) {
  const { t } = useTranslation('components', { keyPrefix: 'feedbackDimensions' })
  const [open, setOpen] = useState(false)
  if (open) return <EditForm feedback={feedback} onClose={() => setOpen(false)} />
  return (
    <button type="button" onClick={() => setOpen(true)} className="btn btn-ghost btn-sm">
      <Layers size={14} aria-hidden="true" />
      {t('edit')}
    </button>
  )
}
