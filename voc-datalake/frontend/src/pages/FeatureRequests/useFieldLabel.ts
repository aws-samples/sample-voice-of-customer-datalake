/**
 * @fileoverview A catalogue field's label in the board forms, saying "(required)" or "(optional)"
 * as the board's switch has it.
 *
 * @module pages/FeatureRequests/useFieldLabel
 */
import { useTranslation } from 'react-i18next'
import type { FieldKey } from '../../api/boardFields'
import { FIELD_LABELS } from './boardLabels'

export function useFieldLabel(): (key: FieldKey, required: boolean) => string {
  const { t } = useTranslation('featureRequests')
  return (key, required) => t(required ? 'form.requiredLabel' : 'form.optionalLabel', { label: t(FIELD_LABELS[key].labelKey) })
}
