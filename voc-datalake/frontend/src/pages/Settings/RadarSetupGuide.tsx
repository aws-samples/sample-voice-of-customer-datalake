/**
 * @fileoverview Administration → Sources → Radar, above the scan settings: the brand list editor
 * (RadarBrandsEditor, with the 90-day review counts from GET /radar) and how Radar works in
 * three steps (docs/radar.md → "Turning it on").
 * @module pages/Settings/RadarSetupGuide
 */
import { useTranslation } from 'react-i18next'
import RadarBrandsEditor from './RadarBrandsEditor'
import type { RadarBrandSummary } from '../../api/radarSchema'

const HOW_STEPS = ['step1', 'step2', 'step3'] as const

function HowRadarWorks() {
  const { t } = useTranslation('radar')
  return (
    <section aria-labelledby="radar-how-it-works" className="rounded-lg border border-border bg-bg-accent p-4 space-y-2">
      <h3 id="radar-how-it-works" className="text-sm font-semibold tracking-tight text-text-strong">{t('setup.howTitle')}</h3>
      <ol className="space-y-2">
        {HOW_STEPS.map((step, index) => (
          <li key={step} className="flex gap-3 text-sm">
            <span className="badge badge-muted font-mono h-fit" aria-hidden="true">{index + 1}</span>
            <span>
              <span className="font-medium text-text-strong">{t(`setup.${step}Title`)}. </span>
              <span className="text-text">{t(`setup.${step}`)}</span>
            </span>
          </li>
        ))}
      </ol>
    </section>
  )
}

export default function RadarSetupGuide({ brands }: Readonly<{ brands: readonly RadarBrandSummary[] }>) {
  return (
    <div className="space-y-4">
      <RadarBrandsEditor totals={new Map(brands.map((brand) => [brand.key, brand.total]))} />
      <HowRadarWorks />
    </div>
  )
}
