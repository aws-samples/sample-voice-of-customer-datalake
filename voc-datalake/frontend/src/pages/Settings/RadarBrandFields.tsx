/**
 * @fileoverview The fields of one Radar brand, shared by a brand's row (Edit) and "Add a brand"
 * (docs/radar.md): its search language (Auto = the language of its domain) and its news feeds
 * (up to 3 https RSS / Atom links, one per line or comma separated), its search terms and exclude
 * terms (one per line), plus a row's domains.
 * Each field holds the text as typed and hands the draft the parsed value.
 * @module pages/Settings/RadarBrandFields
 */
import { useId, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { MAX_RADAR_DOMAINS } from '../../api/radarSchema'
import ChoiceSelect from '../../components/ChoiceSelect/ChoiceSelect'
import { MAX_RADAR_FEEDS, MAX_RADAR_TERMS, MAX_RADAR_TERM_CHARS, RADAR_LANGUAGES, isRadarLanguage } from '../../api/radarNewsFields'
import { languageName } from '../../utils/languageName'
import { feedsProblem, splitDomains, splitFeeds, splitTerms, termsProblem } from './radarBrandDraft'
import { useLanguageSummary } from './useLanguageSummary'
import type { RadarLanguage } from '../../api/radarNewsFields'
import type { FeedsProblem, TermsField as TermsFieldName, TermsProblem } from './radarBrandDraft'

const FIELD_LABEL = 'block text-xs font-medium text-text mb-1'

// Held as `…Key:` data so scripts/i18n-check.mjs sees each message.
const FEEDS_PROBLEMS: Record<FeedsProblem, { messageKey: string }> = {
  feedsTooMany: { messageKey: 'radar:brands.feedsTooMany' },
  feedsHttps: { messageKey: 'radar:brands.feedsHttps' },
}

const TERMS_PROBLEMS: Record<TermsProblem, { messageKey: string }> = {
  termsTooMany: { messageKey: 'radar:brands.termsTooMany' },
  termsTooLong: { messageKey: 'radar:brands.termsTooLong' },
  termsInvalid: { messageKey: 'radar:brands.termsInvalid' },
}

const TERMS_TEXT: Record<TermsFieldName, { labelKey: string; hintKey: string; placeholder: string }> = {
  search_terms: { labelKey: 'radar:brands.searchTermsLabel', hintKey: 'radar:brands.searchTermsHint', placeholder: 'Example Air Ltd.' },
  exclude_terms: { labelKey: 'radar:brands.excludeTermsLabel', hintKey: 'radar:brands.excludeTermsHint', placeholder: 'employee benefits' },
}

/** Auto (with the language the server derived from the domain), then the 16 languages by name. */
export function LanguageSelect({ language, effective, onChange }: Readonly<{
  language: RadarLanguage | null; effective: RadarLanguage | null; onChange: (language: RadarLanguage | null) => void
}>) {
  const { t, i18n } = useTranslation('radar')
  const summary = useLanguageSummary()
  // Named in the reader's UI language ("Polish", de "Polnisch"), like the Auto choice.
  return (
    <ChoiceSelect label={t('brands.languageLabel')} noneLabel={summary(null, effective)} choices={RADAR_LANGUAGES} value={language}
      isChoice={isRadarLanguage} display={(code) => languageName(code, i18n.language)} onChange={onChange}
      className="select w-full sm:w-auto" />
  )
}

/** The feeds as typed; the parsed list reaches the draft, with what is wrong with it said under the box. */
export function FeedsField({ feeds, onChange }: Readonly<{ feeds: readonly string[]; onChange: (feeds: string[]) => void }>) {
  const { t } = useTranslation('radar')
  const id = useId()
  const hintId = useId()
  const [text, setText] = useState(feeds.join('\n'))
  const problem = feedsProblem(feeds)
  return (
    <div>
      <label htmlFor={id} className={FIELD_LABEL}>{t('brands.feedsLabel')}</label>
      <textarea id={id} rows={3} className="input font-mono text-sm" value={text} placeholder="https://example.com/news/feed"
        aria-describedby={hintId} aria-invalid={problem !== null}
        onChange={(e) => { setText(e.target.value); onChange(splitFeeds(e.target.value)) }} />
      <p id={hintId} className="text-xs text-muted mt-1">{t('brands.feedsHint', { max: MAX_RADAR_FEEDS })}</p>
      {problem === null ? null : (
        <p role="alert" className="text-xs text-danger mt-1">{t(FEEDS_PROBLEMS[problem].messageKey, { max: MAX_RADAR_FEEDS })}</p>
      )}
    </div>
  )
}

/** A brand's search terms or exclude terms, one per line; what is wrong with them is said under the box. */
export function TermsField({ field, terms, onChange }: Readonly<{
  field: TermsFieldName; terms: readonly string[]; onChange: (terms: string[]) => void
}>) {
  const { t } = useTranslation('radar')
  const id = useId()
  const hintId = useId()
  const [text, setText] = useState(terms.join('\n'))
  const problem = termsProblem(terms)
  const copy = TERMS_TEXT[field]
  const limits = { max: MAX_RADAR_TERMS, chars: MAX_RADAR_TERM_CHARS }
  return (
    <div>
      <label htmlFor={id} className={FIELD_LABEL}>{t(copy.labelKey)}</label>
      <textarea id={id} rows={3} className="input text-sm" value={text} placeholder={copy.placeholder}
        aria-describedby={hintId} aria-invalid={problem !== null}
        onChange={(e) => { setText(e.target.value); onChange(splitTerms(e.target.value)) }} />
      <p id={hintId} className="text-xs text-muted mt-1">{t(copy.hintKey, limits)}</p>
      {problem === null ? null : (
        <p role="alert" className="text-xs text-danger mt-1">{t(TERMS_PROBLEMS[problem].messageKey, limits)}</p>
      )}
    </div>
  )
}

/** A row's domains, comma separated, edited in place. */
export function DomainsField({ label, domains, onChange }: Readonly<{
  label: string; domains: readonly string[]; onChange: (domains: string[]) => void
}>) {
  const { t } = useTranslation('radar')
  const id = useId()
  const [text, setText] = useState(domains.join(', '))
  return (
    <div>
      <label htmlFor={id} className="sr-only">{label}</label>
      <input id={id} type="text" className="input font-mono text-sm" value={text} placeholder="example.com"
        onChange={(e) => { setText(e.target.value); onChange(splitDomains(e.target.value)) }} />
      <p className="text-xs text-muted mt-1">{t('brands.domainsHint', { max: MAX_RADAR_DOMAINS })}</p>
    </div>
  )
}
