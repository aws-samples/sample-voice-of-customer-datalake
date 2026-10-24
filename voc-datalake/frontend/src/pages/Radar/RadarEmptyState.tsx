/**
 * @fileoverview What the Radar page says before any source tracks another brand:
 * how to add a Radar source (admins get a link to the Radar setup card, which lists the
 * brands, explains how Radar works and links on to Source policies).
 * @module pages/Radar/RadarEmptyState
 */
import { Radar } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import SectionTitle from './SectionTitle'
import { Link } from 'react-router-dom'
import { useIsAdmin } from '../../store/authStore'
import { RADAR_SETUP_PATH } from './radarFormat'

export default function RadarEmptyState() {
  const { t } = useTranslation('radar')
  const isAdmin = useIsAdmin()
  return (
    <section className="card space-y-3" aria-labelledby="radar-empty">
      <SectionTitle id="radar-empty" icon={Radar}>{t('empty.title')}</SectionTitle>
      <p className="text-sm text-muted">{t('empty.body')}</p>
      <ol className="list-decimal pl-5 space-y-1 text-sm text-text">
        <li>{t('empty.step1')}</li>
        <li>{t('empty.step2')}</li>
        <li>{t('empty.step3')}</li>
      </ol>
      {isAdmin ? <Link to={RADAR_SETUP_PATH} className="btn btn-secondary btn-sm">{t('empty.openSetup')}</Link> : null}
    </section>
  )
}
