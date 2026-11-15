/**
 * @fileoverview The formats the Skills screens share (SkillHistory.tsx, SkillVersionDetail.tsx, EngineeringSkills.tsx,
 * SkillScorecards.tsx): a time in the reader's language, a pass rate as a percentage ("–" when there is none).
 *
 * @module pages/Agents/skillFormats
 */
import { useTranslation } from 'react-i18next'
import { formatDateTime } from '../../utils/dateUtils'

export function useSkillFormats() {
  const { i18n } = useTranslation()
  const percent = new Intl.NumberFormat(i18n.language, { style: 'percent', maximumFractionDigits: 0 })
  return {
    at: (value: string) => formatDateTime(value, i18n.language, value),
    rate: (value: number | null) => (value === null ? '–' : percent.format(value)),
  }
}
