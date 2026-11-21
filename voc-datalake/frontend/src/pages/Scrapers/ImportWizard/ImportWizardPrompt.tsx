/**
 * @fileoverview The import wizard's call to action on a new workspace's Home (7.67.00): no feedback yet, so bring
 * your own (a store export, tickets or another survey tool's results) in minutes. Shown to whoever may import (in a
 * workspace its admins), above the setup checklist.
 *
 * @module pages/Scrapers/ImportWizard/ImportWizardPrompt
 */
import { ArrowRight, FileUp } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router-dom'
import { useCanImport } from './useCanImport'

/** Shown, to whoever may import, once Home knows there is no feedback yet (`empty`) and its answer is in. */
export default function ImportWizardPrompt({ empty, resolving }: Readonly<{ empty: boolean; resolving: boolean }>) {
  const { t } = useTranslation('scrapers')
  const canImport = useCanImport()
  if (!empty || resolving || !canImport) return null
  return (
    <section className="card flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between" aria-labelledby="import-wizard-prompt">
      <div className="flex items-start gap-3">
        <FileUp size={20} className="mt-0.5 shrink-0 text-accent" aria-hidden="true" />
        <div>
          <h2 id="import-wizard-prompt" className="text-sm font-semibold text-text-strong">{t('importWizard.prompt.title')}</h2>
          <p className="text-sm text-muted">{t('importWizard.prompt.body')}</p>
        </div>
      </div>
      <Link to="/scrapers/import" className="btn btn-primary shrink-0">{t('importWizard.open')} <ArrowRight size={14} aria-hidden="true" /></Link>
    </section>
  )
}
