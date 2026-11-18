/**
 * @fileoverview The "Try" examples under the description (UX §12.1): a chip fills an empty description; over text of
 * the person's own it asks first, inline ("Replace your description? [Replace] [Keep mine]"). The first example is
 * the pilot's case: it also sets the language to Polski and Runs to In-app.
 *
 * @module pages/FeedbackForms/picker/DescribeExamples
 */
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { Channel, FormLanguage } from '../model/formsV2'

export interface DescribeExample {
  readonly key: string
  readonly text: string
  readonly language?: FormLanguage
  readonly channel?: Channel
}

/** The examples' keys, literal so the i18n audit sees them. */
const EXAMPLES: readonly { readonly key: string; readonly chip: string; readonly text: string; readonly language?: FormLanguage; readonly channel?: Channel }[] = [
  { key: 'oldUi', chip: 'describe.examples.oldUi.chip', text: 'describe.examples.oldUi.text', language: 'pl', channel: 'in_app' },
  { key: 'nps', chip: 'describe.examples.nps.chip', text: 'describe.examples.nps.text' },
  { key: 'support', chip: 'describe.examples.support.chip', text: 'describe.examples.support.text' },
  { key: 'churn', chip: 'describe.examples.churn.chip', text: 'describe.examples.churn.text' },
]

export default function DescribeExamples({ current, disabled, onUse }: Readonly<{
  /** The description as it stands (an example's own text is not "the person's own"). */
  current: string
  disabled: boolean
  onUse: (example: DescribeExample) => void
}>) {
  const { t } = useTranslation('feedbackForms')
  const [asking, setAsking] = useState<DescribeExample | null>(null)
  const examples: DescribeExample[] = EXAMPLES.map(({ key, text, language, channel }) => ({ key, text: t(text), language, channel }))
  const ownText = current.trim() !== '' && !examples.some((example) => example.text === current)
  const pick = (example: DescribeExample) => {
    if (ownText) setAsking(example)
    else onUse(example)
  }
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[12px] text-muted">{t('describe.try')}</span>
        {EXAMPLES.map(({ key, chip }, index) => {
          const example = examples[index]
          return example === undefined ? null : (
            <button key={key} type="button" className="btn btn-secondary btn-sm" disabled={disabled} onClick={() => pick(example)}>
              {t(chip)}
            </button>
          )
        })}
      </div>
      {asking !== null && (
        <div role="group" aria-label={t('describe.replaceAsk')} className="flex flex-wrap items-center gap-2 rounded-md border border-border bg-bg-accent px-3 py-2 text-[13px] text-text">
          <span className="mr-auto">{t('describe.replaceAsk')}</span>
          <button type="button" className="btn btn-primary btn-sm" onClick={() => { onUse(asking); setAsking(null) }}>{t('describe.replace')}</button>
          <button type="button" className="btn btn-secondary btn-sm" onClick={() => setAsking(null)}>{t('describe.keepMine')}</button>
        </div>
      )}
    </div>
  )
}
