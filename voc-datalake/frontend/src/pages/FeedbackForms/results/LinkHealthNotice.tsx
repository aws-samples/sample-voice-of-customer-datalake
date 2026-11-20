/**
 * @fileoverview The link checks (7.61.00, docs/feedback-forms.md "Link checks"): whether the links that bring
 * respondents fill the form's hidden fields. One banner on Results and on Share, a line per warning the server gave
 * (`never_filled`: none of at least 5 responses had the field; `mostly_missing`: 80 % or more of at least 10 lacked
 * it), with the link parameter that fills it (`hf_<id>=`) and where the responses without it came from. Nothing when
 * there is nothing to warn about, or the server checks no links.
 *
 * @module pages/FeedbackForms/results/LinkHealthNotice
 */
import { useTranslation } from 'react-i18next'
import { Unlink } from 'lucide-react'
import Notice from '../../../components/Notice/Notice'
import type { LinkHealth, LinkWarning } from '../../../api/feedbackFormsV2Results'
import { formatCount } from '../../../utils/numberFormat'

/** Where the responses without the field came from: "Link 18 · Embedded 8" (channels missing it, most first). */
function missingFrom(health: LinkHealth, id: string, words: (channel: string, count: number) => string): string {
  return Object.entries(health.by_channel)
    .map(([channel, figures]) => ({ channel, missing: figures.hidden[id]?.missing ?? 0 }))
    .filter((entry) => entry.missing > 0)
    .sort((a, b) => b.missing - a.missing)
    .map((entry) => words(entry.channel, entry.missing))
    .join(' · ')
}

function WarningLine({ health, warning }: Readonly<{ health: LinkHealth; warning: LinkWarning }>) {
  const { t, i18n } = useTranslation('feedbackForms')
  const count = (value: number) => formatCount(value, i18n.language)
  const channelName = (name: string): string => {
    if (name === 'link') return t('card.channels.link')
    if (name === 'script') return t('card.channels.script')
    return name === 'iframe' ? t('card.channels.iframe') : t('results.linkHealth.unknown')
  }
  const channel = (name: string, missing: number) => t('results.linkHealth.channel', { channel: channelName(name), missing: count(missing) })
  const from = missingFrom(health, warning.id, channel)
  // (the counts as numbers: the strings format them, `{{filled, number}}`)
  const words = { id: warning.id, filled: warning.filled, total: warning.total }
  return (
    <li className="space-y-0.5">
      <span className="block">{warning.kind === 'never_filled' ? t('results.linkHealth.never_filled', words) : t('results.linkHealth.mostly_missing', words)}</span>
      <span className="block text-[12px] text-muted">
        {t('results.linkHealth.hint', { param: `hf_${warning.id}=` })}
        {from !== '' && <> {t('results.linkHealth.from', { channels: from })}</>}
      </span>
    </li>
  )
}

export default function LinkHealthNotice({ health, action }: Readonly<{
  health: LinkHealth | null
  /** The banner's one action (Results: open Share). */
  action?: { readonly label: string; readonly onClick: () => void }
}>) {
  const { t } = useTranslation('feedbackForms')
  if (health === null || health.warnings.length === 0) return null
  return (
    <Notice variant="banner" tone="warn" role="note" icon={Unlink} action={action}
      text={(
        <span className="block space-y-1">
          <span className="block font-medium">{t('results.linkHealth.title')}</span>
          <ul className="space-y-1">
            {health.warnings.map((warning) => <WarningLine key={warning.id} health={health} warning={warning} />)}
          </ul>
        </span>
      )} />
  )
}
