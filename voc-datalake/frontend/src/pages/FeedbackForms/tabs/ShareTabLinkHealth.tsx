/**
 * @fileoverview The Share tab's link checks (docs/feedback-forms.md "Link checks"): the same banner Results
 * shows, over every real response, so whoever shares the form sees a link that never filled a hidden field before
 * sharing it again. Nothing while the results load or cannot be read (Results says why), or when nothing is wrong.
 *
 * @module pages/FeedbackForms/tabs/ShareTabLinkHealth
 */
import { useTranslation } from 'react-i18next'
import { useBuilderUi } from '../builder/builderUi'
import LinkHealthNotice from '../results/LinkHealthNotice'
import { ALL_REAL_RESPONSES, useFormResults } from '../results/useFormResults'

export default function ShareTabLinkHealth({ formId }: Readonly<{ formId: string }>) {
  const { t } = useTranslation('feedbackForms')
  const { go } = useBuilderUi()
  const { data } = useFormResults(formId, ALL_REAL_RESPONSES)
  return <LinkHealthNotice health={data?.link_health ?? null} action={{ label: t('share.toHiddenFields'), onClick: () => go('hidden-fields') }} />
}
