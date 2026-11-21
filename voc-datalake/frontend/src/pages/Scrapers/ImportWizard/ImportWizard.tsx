/**
 * @fileoverview The import wizard (7.67.00, docs/import-wizard.md), `/scrapers/import`: bring your own signals in
 * minutes. Four steps: Upload (a CSV, TSV, JSON or Excel file; the server reads its first 256 KB and says what each
 * column holds), Map (reviews or tickets, or a survey export; every column's kind with its confidence and reason,
 * every one overridable, personal data dropped by default), Confirm (a survey's inferred questions; what goes where for
 * reviews) and First insights (the import's progress, then its sentiment, top categories, NPS and three quotes).
 * Admins only, like every import: in a workspace its admins (useCanImport.ts; the server decides every call).
 *
 * @module pages/Scrapers/ImportWizard/ImportWizard
 */
import { ArrowLeft } from 'lucide-react'
import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router-dom'
import { PageTitle } from '../../../components/PageTitle/PageTitle'
import ConfirmStep from './ConfirmStep'
import InsightsStep from './InsightsStep'
import MapStep from './MapStep'
import UploadStep from './UploadStep'
import { useCanImport } from './useCanImport'
import { useImportWizard } from './useImportWizard'
import type { WizardStep } from './useImportWizard'
import WizardSteps from './WizardSteps'

function StepBody({ wizard }: Readonly<{ wizard: ReturnType<typeof useImportWizard> }>) {
  const steps: Record<WizardStep, () => ReactNode> = {
    upload: () => <UploadStep wizard={wizard} />,
    map: () => <MapStep wizard={wizard} />,
    confirm: () => <ConfirmStep wizard={wizard} />,
    insights: () => <InsightsStep wizard={wizard} />,
  }
  return steps[wizard.step]()
}

function Wizard() {
  const wizard = useImportWizard()
  return (
    <>
      <WizardSteps step={wizard.step} />
      {wizard.error !== null && <p role="alert" className="text-sm text-danger">{wizard.error}</p>}
      <StepBody wizard={wizard} />
    </>
  )
}

export default function ImportWizard() {
  const { t } = useTranslation('scrapers')
  const canImport = useCanImport()
  return (
    <div className="max-w-4xl mx-auto space-y-4 sm:space-y-6">
      <Link to="/scrapers" className="inline-flex items-center gap-1 text-sm text-muted hover:text-text-strong">
        <ArrowLeft size={14} aria-hidden="true" /> {t('importWizard.backToSources')}
      </Link>
      <PageTitle title={t('importWizard.title')} subtitle={t('importWizard.subtitle')} />
      {canImport ? <Wizard /> : <p className="card text-sm text-muted">{t('importWizard.adminOnly')}</p>}
    </div>
  )
}
