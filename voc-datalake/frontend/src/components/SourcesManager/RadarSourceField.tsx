/**
 * @fileoverview The Radar note on one source profile (docs/radar.md). Radar brands are set up
 * in Administration → Sources → Radar now, and a scraper or connector picks its brand on the
 * Scrapers page, so a profile no longer offers "Radar source". A legacy profile that already
 * names a brand keeps it (the backend still reads it, and the source's reviews still go to
 * Radar); it is shown read-only, with a link to where brands are set up. An ordinary profile
 * shows nothing.
 * @module components/SourcesManager/RadarSourceField
 */
import { Radar } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router-dom'
import { RADAR_SETUP_PATH } from '../../pages/Radar/radarFormat'
import type { SourceProfile } from '../../api/sourceProfilesApi'

export default function RadarSourceField({ profile }: Readonly<{ profile: SourceProfile }>) {
  const { t } = useTranslation('components', { keyPrefix: 'sourcesManager' })
  if (profile.radar_brand === undefined) return null
  return (
    <div role="note" className="rounded-lg border border-border bg-bg-accent p-3 text-sm flex items-start gap-2">
      <Radar size={16} className="text-accent shrink-0 mt-0.5" aria-hidden="true" />
      <div className="space-y-1">
        <p className="text-text">{t('radarLegacy', { brand: profile.radar_brand })}</p>
        <p className="text-xs text-muted">
          {t('radarLegacyHint')}{' '}
          <Link to={RADAR_SETUP_PATH} className="link">{t('radarLegacyLink')}</Link>
        </p>
      </div>
    </div>
  )
}
