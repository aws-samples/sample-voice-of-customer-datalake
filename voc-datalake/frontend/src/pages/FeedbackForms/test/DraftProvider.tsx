/**
 * @fileoverview The provider `draftHarness.tsx` renders a spec's node in: a real draft (`useFormDraft`) and the
 * builder's UI context, reporting the draft after every render (`onDraft`).
 *
 * @module pages/FeedbackForms/test/DraftProvider
 */
import { useEffect } from 'react'
import type { ReactNode } from 'react'
import type { LoadedForm } from '../model/formsV2'
import { FormDraftContext } from '../builder/formDraftContext'
import type { FormDraft } from '../builder/formDraftContext'
import { BuilderUiContext } from '../builder/builderUi'
import type { BuilderUi } from '../builder/builderUi'
import { useFormDraft } from '../builder/useFormDraft'
import type { NewFormHandoff } from '../builder/newFormHandoff'

export default function DraftProvider({ loaded, handoff, ui, onDraft, onCreated, children }: Readonly<{
  loaded: LoadedForm | null
  handoff: NewFormHandoff | null
  ui: BuilderUi
  onDraft: (draft: FormDraft) => void
  onCreated: (formId: string) => void
  children: ReactNode
}>) {
  const draft = useFormDraft({ loaded, handoff, onCreated })
  useEffect(() => { onDraft(draft) })
  return (
    <FormDraftContext.Provider value={draft}>
      <BuilderUiContext.Provider value={ui}>{children}</BuilderUiContext.Provider>
    </FormDraftContext.Provider>
  )
}
