/**
 * @fileoverview Translated labels for the built-in dimensions.
 *
 * The backend sends the built-in `feedback_type` with English labels
 * (lambda/shared/feedback_types.py); the SPA shows them in the reader's language
 * from `common.json` (`feedbackDimension.label`, `feedbackTypes.<value>`,
 * `feedbackTypeDescriptions.<value>`). Admin-defined dimensions are left as typed.
 *
 * @module api/builtinDimensionLabels
 */
import type { TFunction } from 'i18next'
import { FEEDBACK_TYPE_KEY, feedbackTypeCopy } from './feedbackTypes'
import type { Dimension, DimensionValue, DimensionsConfig } from './dimensionsSchema'

function localizedValue(value: DimensionValue, t: TFunction): DimensionValue {
  const copy = feedbackTypeCopy(value.name)
  return copy === undefined ? value : { ...value, label: t(copy.labelKey), description: t(copy.descriptionKey) }
}

function localizedDimension(dimension: Dimension, t: TFunction): Dimension {
  if (dimension.builtin !== true || dimension.key !== FEEDBACK_TYPE_KEY) return dimension
  return {
    ...dimension,
    label: t('common:feedbackDimension.label'),
    description: t('common:feedbackDimension.description'),
    values: dimension.values.map((value) => localizedValue(value, t)),
  }
}

/** `config` with the built-in dimensions' labels and descriptions in the current language. */
export function localizeBuiltinDimensions(config: DimensionsConfig, t: TFunction): DimensionsConfig {
  return { ...config, dimensions: config.dimensions.map((dimension) => localizedDimension(dimension, t)) }
}
