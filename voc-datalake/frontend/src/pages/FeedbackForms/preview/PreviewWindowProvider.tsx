/**
 * @fileoverview The builder's one link to its preview window (usePreviewWindowSync.ts), for everything inside the
 * builder that opens or follows it (previewWindowContext.ts): the window keeps showing the draft on every tab.
 *
 * @module pages/FeedbackForms/preview/PreviewWindowProvider
 */
import type { ReactNode } from 'react'
import type { FormV2 } from '../model/formsV2'
import { PreviewWindowContext } from './previewWindowContext'
import { usePreviewWindowSync } from './usePreviewWindowSync'

export default function PreviewWindowProvider({ form, formKey, children }: Readonly<{
  form: FormV2
  /** Whose preview session it is: the form's id, or `new` for an unsaved form (its first save keeps the session). */
  formKey: string
  children: ReactNode
}>) {
  const api = usePreviewWindowSync(form, formKey)
  return <PreviewWindowContext.Provider value={api}>{children}</PreviewWindowContext.Provider>
}
