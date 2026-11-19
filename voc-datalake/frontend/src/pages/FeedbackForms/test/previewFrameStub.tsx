/**
 * @fileoverview A stand-in for `preview/PreviewFrame` in specs (the real widget script never runs in jsdom):
 * `vi.mock('../preview/PreviewFrame', () => import('../test/previewFrameStub'))`. It renders the preview region
 * by its name and the language it would speak.
 *
 * @module pages/FeedbackForms/test/previewFrameStub
 */
import type { FormLanguage } from '../model/formsV2'

export default function PreviewFrameStub({ title, language }: Readonly<{ title: string; language: FormLanguage }>) {
  return <section aria-label={title} lang={language} data-testid="preview-frame" />
}
