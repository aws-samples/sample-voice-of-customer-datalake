/**
 * @fileoverview The "All agents" link at the top of an agent's page and of a
 * library workflow's page.
 *
 * @module pages/Agents/BackToAgents
 */
import { Link } from 'react-router-dom'
import { ArrowLeft } from 'lucide-react'
import { useTranslation } from 'react-i18next'

export function BackToAgents() {
  const { t } = useTranslation('agents')
  return (
    <Link to="/agents" className="inline-flex items-center gap-1 text-[13px] text-muted hover:text-text">
      <ArrowLeft size={14} aria-hidden="true" /> {t('detail.back')}
    </Link>
  )
}
