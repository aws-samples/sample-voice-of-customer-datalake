/**
 * @fileoverview The compact number-tick formatter (`10K`) for the UI language,
 * built once per language — shared by every Dashboard chart's number axis.
 * @module pages/Dashboard/useCompactTick
 */
import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { compactFormatter } from './axisLabel'

export function useCompactTick(): (value: unknown) => string {
  const { i18n } = useTranslation()
  const language = i18n.language
  return useMemo(() => compactFormatter(language), [language])
}
