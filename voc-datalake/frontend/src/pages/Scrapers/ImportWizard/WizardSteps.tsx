/**
 * @fileoverview The import wizard's four steps as an ordered list, the current one marked (`aria-current="step"`).
 *
 * @module pages/Scrapers/ImportWizard/WizardSteps
 */
import clsx from 'clsx'
import { Check } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { WizardStep } from './useImportWizard'

const STEPS: readonly WizardStep[] = ['upload', 'map', 'confirm', 'insights']
const LABELS: Readonly<Record<WizardStep, string>> = {
  upload: 'importWizard.steps.upload',
  map: 'importWizard.steps.map',
  confirm: 'importWizard.steps.confirm',
  insights: 'importWizard.steps.insights',
}

export default function WizardSteps({ step }: Readonly<{ step: WizardStep }>) {
  const { t } = useTranslation('scrapers')
  const current = STEPS.indexOf(step)
  return (
    <ol className="flex flex-wrap gap-2" aria-label={t('importWizard.stepOf', { current: current + 1, total: STEPS.length })}>
      {STEPS.map((name, index) => (
        <li key={name} aria-current={index === current ? 'step' : undefined}
          className={clsx('inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs',
            index === current ? 'border-accent bg-accent-subtle text-text-strong font-medium' : 'border-border text-muted')}>
          {index < current ? <Check size={12} aria-hidden="true" /> : <span aria-hidden="true">{index + 1}</span>}
          {t(LABELS[name])}
        </li>
      ))}
    </ol>
  )
}
