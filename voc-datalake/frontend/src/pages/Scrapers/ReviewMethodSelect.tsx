/**
 * @fileoverview "Read with" on the review page form: Automatic (recommended), Browser only or Bedrock web index
 * only (webReviewMethod.ts), with what the choice does. The options are the deployed manifest's, their labels in the
 * UI language (the manifest's own labels are English).
 * @module pages/Scrapers/ReviewMethodSelect
 */
import { useId } from 'react'
import { useTranslation } from 'react-i18next'
import { AUTO_METHOD, offeredReviewMethods } from './webReviewMethod'
import type { ReviewMethod } from './webReviewMethod'
import type { PluginManifest } from '../../plugins/types'

/** Each method's option label. */
const OPTION_KEYS: Readonly<Record<ReviewMethod, string>> = {
  auto: 'appCard.method.option.auto',
  browser: 'appCard.method.option.browser',
  bedrock_web_search: 'appCard.method.option.bedrock',
}

/** What each method does, under the select (a Bedrock page also shows its attribution note above the fields). */
const HELP_KEYS: Readonly<Record<ReviewMethod, string>> = {
  auto: 'appCard.method.help.auto',
  browser: 'appCard.method.help.browser',
  bedrock_web_search: 'appCard.method.help.bedrock',
}

export default function ReviewMethodSelect({ plugin, value, onChange }: Readonly<{
  plugin: PluginManifest
  value: ReviewMethod
  onChange: (method: ReviewMethod) => void
}>) {
  const { t } = useTranslation('scrapers')
  const id = useId()
  const helpId = useId()
  const offered = offeredReviewMethods(plugin)
  return (
    <div>
      <label htmlFor={id} className="block text-sm font-medium text-text mb-1">{t('appCard.method.label')}</label>
      <select id={id} value={value} aria-describedby={helpId} className="select"
        onChange={(event) => onChange(offered.find((method) => method === event.target.value) ?? AUTO_METHOD)}>
        {offered.map((method) => <option key={method} value={method}>{t(OPTION_KEYS[method])}</option>)}
      </select>
      <p id={helpId} className="mt-1 text-xs text-muted">{t(HELP_KEYS[value])}</p>
    </div>
  )
}
