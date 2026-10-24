/**
 * @fileoverview The local-draft lifecycle shared by the Dimensions and Sources
 * editors: edit marks the draft dirty, Discard returns to what is stored, Save
 * sends the wire form, and the props for `DraftSaveBar` come back ready.
 *
 * @module components/DraftSaveBar/useDraftEditor
 */
import { useState } from 'react'
import type { FocusEvent } from 'react'
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
  // Validate on blur / submit (live finding: "key is required" showed before
  // anyone had typed). The reason appears once a field is left or Save is tried.
  const [revealed, setRevealed] = useState(false)

  const edit = (next: Draft) => {
    setDraft(next)
    setDirty(true)
    mutation.reset()
  }

  const barProps: ComponentProps<typeof DraftSaveBar> = {
    dirty,
    blockedReason: found === null || !revealed ? null : t(found.messageKey, found.params),
    pending: mutation.isPending,
    saved: mutation.isSuccess,
    error: mutation.error,
    onSave: () => {
      if (found !== null) setRevealed(true)
      else mutation.mutate(options.toWire(draft))
    },
    onDiscard: () => {
      setDraft(options.initial())
      setDirty(false)
      setRevealed(false)
      mutation.reset()
    },
  }

  /** Put on the editor's container: leaving a text field or a select shows the draft's problem. */
  const onFieldBlur = (event: FocusEvent<HTMLElement>) => {
    const { target } = event
    if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement) setRevealed(true)
  }

  return { draft, edit, barProps, onFieldBlur }
}
