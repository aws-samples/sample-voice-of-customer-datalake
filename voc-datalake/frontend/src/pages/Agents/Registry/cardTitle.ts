/**
 * @fileoverview A Registry card's name: a role's in the reader's language (Skills' role names), a made card's own title.
 *
 * @module pages/Agents/Registry/cardTitle
 */
import { useTranslation } from 'react-i18next'
import { isSkillRole } from '../../../api/engineeringSkillsApi'
import type { RegistryCard } from '../../../api/engineeringRegistryApi'

export function useCardTitle() {
  const { t } = useTranslation('agents')
  return (card: RegistryCard) => (card.kind === 'role' && isSkillRole(card.id) ? t(`skills.role.${card.id}`) : card.title)
}
