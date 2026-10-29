/**
 * @fileoverview A request's description on its board's terms: the hint names what the template asks
 * for (what the customer needs, what happened, what you tried), the label says "(optional)" where
 * the template does not require one (api/boardFields.ts `isDescriptionRequired`, mirrored by the API).
 *
 * @module pages/FeatureRequests/DescriptionField
 */
import { useTranslation } from 'react-i18next'
import { isDescriptionRequired } from '../../api/boardFields'
import { TextField } from './FormFields'
import { REQUEST_LIMITS } from './boardFormat'
import { DESCRIPTION_HINTS } from './boardLabels'
import type { BoardTemplate } from '../../api/boardFields'

export default function DescriptionField({ template, value, rows, error, onChange }: Readonly<{
  template: BoardTemplate; value: string; rows: number; error?: string; onChange: (value: string) => void
}>) {
  const { t } = useTranslation('featureRequests')
  const label = isDescriptionRequired(template) ? t('form.description') : t('form.optionalLabel', { label: t('form.description') })
  return (
    <TextField label={label} rows={rows} value={value} maxLength={REQUEST_LIMITS.description} error={error}
      hint={t(DESCRIPTION_HINTS[template].messageKey)} onChange={onChange} />
  )
}
