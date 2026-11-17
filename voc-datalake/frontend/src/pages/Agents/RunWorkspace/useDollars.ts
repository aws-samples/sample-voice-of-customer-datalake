/**
 * @fileoverview An amount in USD with two decimals in the reader's language, as the run workspace says a run's cost
 * (its header, its end banner, its supervisor's lines; 7.51.04: one formatter for the three).
 *
 * @module pages/Agents/RunWorkspace/useDollars
 */
import { useTranslation } from 'react-i18next'

export function useDollars(): (value: number) => string {
  const { i18n } = useTranslation()
  const format = new Intl.NumberFormat(i18n.language, { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2 })
  return (value) => format.format(value)
}
