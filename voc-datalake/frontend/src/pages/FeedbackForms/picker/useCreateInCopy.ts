/**
 * @fileoverview The "Create in" language's template copy (UX §2.1, §2.3): the picker's cards describe templates in
 * the app's language, but a form is made in the language its respondents read. That language's catalogue is loaded
 * on demand (`i18n.loadLanguages`), then each template text is looked up in it.
 *
 * @module pages/FeedbackForms/picker/useCreateInCopy
 */
import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { i18n as I18n } from 'i18next'
import type { CopyLookup } from '../formTemplates'
import { templateForm } from '../formTemplates'
import type { TemplateFlow } from '../templates/templateKit'
import type { FormLanguage, FormV2 } from '../model/formsV2'
import { isFormLanguage } from '../model/formsV2'

/** A lookup into one language's `feedbackForms` catalogue (undefined where the key has no text). */
function copyLookup(i18n: I18n, language: FormLanguage): CopyLookup {
  return (key) => {
    const full = `feedbackForms:${key}`
    return i18n.exists(full, { lng: language }) ? i18n.t(full, { lng: language }) : undefined
  }
}

/** The app's UI language as a form language (the picker's default "Create in"). */
export function appFormLanguage(language: string): FormLanguage {
  const primary = language.split('-')[0] ?? ''
  return isFormLanguage(primary) ? primary : 'en'
}

export interface CreateInCopy {
  /** The language's catalogue is loaded (until then the preview waits). */
  readonly ready: boolean
  readonly lookup: CopyLookup
  /** The form `flow` makes in the language. */
  readonly formOf: (flow: TemplateFlow) => FormV2
}

export function useCreateInCopy(language: FormLanguage): CreateInCopy {
  const { i18n } = useTranslation('feedbackForms')
  const [loaded, setLoaded] = useState<ReadonlySet<string>>(() => new Set([appFormLanguage(i18n.language)]))
  const ready = loaded.has(language)
  useEffect(() => {
    if (ready) return
    const settle = () => setLoaded((current) => new Set([...current, language]))
    i18n.loadLanguages(language).then(settle, (error: unknown) => {
      // The catalogue could not be read: its texts fall back to the app's (i18next's fallback), still a valid form.
      console.warn('Could not load the template copy for', language, error)
      settle()
    })
  }, [i18n, language, ready])
  return useMemo(() => {
    const lookup = copyLookup(i18n, language)
    return { ready, lookup, formOf: (flow) => templateForm(flow, language, lookup) }
  }, [i18n, language, ready])
}
