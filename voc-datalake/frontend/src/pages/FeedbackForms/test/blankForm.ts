/**
 * @fileoverview A blank form for the forms builder's specs: one long open question and one ending (the Blank
 * template's shape, without copy).
 *
 * @module pages/FeedbackForms/test/blankForm
 */
import type { FormLanguage, FormV2 } from '../model/formsV2'
import { DEFAULT_THEME } from '../model/formsV2'
import { newQuestion } from '../model/defaults'

/** A blank form in `language`. */
export function blankForm(language: FormLanguage): FormV2 {
  return {
    schema_version: 2, name: '', enabled: false, language, languages: [language],
    welcome: { enabled: false, title: {} },
    questions: [newQuestion('open_text', 'q_feedback')],
    hidden_fields: [],
    endings: [{ id: 'end_thanks', title: {} }],
    settings: { test: { link_enabled: false, record: 'tag' } },
    theme: { ...DEFAULT_THEME }, category: '', subcategory: '', project_id: '', document_id: '',
    custom_fields: [], dimension_defaults: {}, tags: [],
  }
}
