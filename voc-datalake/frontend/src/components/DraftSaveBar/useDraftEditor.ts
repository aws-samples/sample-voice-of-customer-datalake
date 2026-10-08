/**
 * @fileoverview The local-draft lifecycle shared by the Dimensions and Sources
 * editors: edit marks the draft dirty, Discard returns to what is stored, Save
 * sends the wire form, and the props for `DraftSaveBar` come back ready.
 *
 * @module components/DraftSaveBar/useDraftEditor
 */
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useMutation } from '@tanstack/react-query'
import type { ComponentProps } from 'react'
import type DraftSaveBar from './DraftSaveBar'

interface DraftProblem {
  messageKey: string
  params: Record<string, string | number>
}

interface DraftEditorOptions<Draft, Wire, Saved> {
  initial: () => Draft
  toWire: (draft: Draft) => Wire
  problem: (draft: Draft) => DraftProblem | null
  save: (wire: Wire) => Promise<Saved>
  onSaved: (saved: Saved) => void
}

export function useDraftEditor<Draft, Wire, Saved>(options: DraftEditorOptions<Draft, Wire, Saved>) {
  const { t } = useTranslation()
  const [draft, setDraft] = useState<Draft>(options.initial)
  const [dirty, setDirty] = useState(false)
  const mutation = useMutation({
    mutationFn: options.save,
    onSuccess: (saved) => {
      options.onSaved(saved)
      setDirty(false)
    },
  })
  const found = options.problem(draft)

  const edit = (next: Draft) => {
    setDraft(next)
    setDirty(true)
    mutation.reset()
  }

  const barProps: ComponentProps<typeof DraftSaveBar> = {
    dirty,
    blockedReason: found === null ? null : t(found.messageKey, found.params),
    pending: mutation.isPending,
    saved: mutation.isSuccess,
    error: mutation.error,
    onSave: () => mutation.mutate(options.toWire(draft)),
    onDiscard: () => {
      setDraft(options.initial())
      setDirty(false)
      mutation.reset()
    },
  }

  return { draft, edit, barProps }
}
