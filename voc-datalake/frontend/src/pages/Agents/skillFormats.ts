/**
 * @fileoverview The formats the Skills screens share (SkillHistory.tsx, SkillVersionDetail.tsx, EngineeringSkills.tsx,
 * SkillScorecards.tsx): a time in the reader's language, a pass rate as a percentage ("–" when there is none), and a
 * version's title ("Fixer · v5").
 *
 * @module pages/Agents/skillFormats
 */
import { useTranslation } from 'react-i18next'
import { formatDateTime } from '../../utils/dateUtils'
import type { SkillRole } from '../../api/engineeringSkillsApi'

/** "Fixer · v5": a version's title. */
export function useSkillTitle() {
  const { t } = useTranslation('agents')
  return (role: SkillRole, version: number) => t('skills.document.title', { role: t(`skills.role.${role}`), version })
}

export function useSkillFormats() {
  const { i18n } = useTranslation()
  const percent = new Intl.NumberFormat(i18n.language, { style: 'percent', maximumFractionDigits: 0 })
  return {
    at: (value: string) => formatDateTime(value, i18n.language, value),
    rate: (value: number | null) => (value === null ? '–' : percent.format(value)),
  }
}
