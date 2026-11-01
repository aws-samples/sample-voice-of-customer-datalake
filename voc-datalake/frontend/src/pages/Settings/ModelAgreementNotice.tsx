/**
 * @fileoverview The "model agreements" notice of the Settings AI models card.
 *
 * The deploy accepts every Claude model's agreement (EULA + Marketplace subscription) best effort,
 * so a refused one never fails it (docs/deployment.md → Model agreements). Each capacity row
 * (GET /settings/model/capacity) carries the account's live access to its model
 * (lambda/shared/model_agreements.py); this lists the models that cannot be called, says what is
 * missing and what to do, and offers the row's Test (one request to exactly that model) to check
 * again after a fix. Nothing renders while every model is available or its access is unknown.
 */
import { useTranslation } from 'react-i18next'
import { FlaskConical, ShieldAlert } from 'lucide-react'
import ModelTestPill from './ModelTestPill'
import { useModelCapacity } from './useModelCapacity'
import type { ModelTests } from './useModelTests'
import type { ImageAccessStatus } from '../../api/imageModelSchema'

/** The access statuses that mean the model's calls fail; `unknown` (not read) is not one. */
const BLOCKED_STATUSES = ['not_subscribed', 'no_access', 'not_in_region'] as const

type BlockedStatus = (typeof BLOCKED_STATUSES)[number]

function isBlocked(status: ImageAccessStatus): status is BlockedStatus {
  return BLOCKED_STATUSES.some((blocked) => blocked === status)
}

interface BlockedModel {
  readonly id: string
  readonly label: string
  readonly status: BlockedStatus
}

interface ModelAgreementNoticeProps {
  readonly models: ReadonlyArray<{ readonly id: string; readonly label: string }>
  readonly tests: ModelTests
}

/** The allowlisted models whose capacity row reports a blocked access, in the picker's order. */
function useBlockedModels(models: ModelAgreementNoticeProps['models']): BlockedModel[] {
  const { data: capacity } = useModelCapacity()
  const statusFor = new Map((capacity?.models ?? []).map((row) => [row.model_id, row.access?.status ?? 'unknown']))
  return models.flatMap((model) => {
    const status = statusFor.get(model.id) ?? 'unknown'
    return isBlocked(status) ? [{ id: model.id, label: model.label, status }] : []
  })
}

export default function ModelAgreementNotice({ models, tests }: ModelAgreementNoticeProps) {
  const { t } = useTranslation('settings')
  const blocked = useBlockedModels(models)
  if (blocked.length === 0) return null

  return (
    <div className="mt-4 rounded-md border border-danger p-3" role="status" aria-labelledby="ai-model-agreements">
      <h3 id="ai-model-agreements" className="text-sm font-semibold text-danger flex items-center gap-1.5">
        <ShieldAlert size={16} aria-hidden="true" /> {t('aiModel.agreement.title')}
      </h3>
      <p className="text-xs text-muted mb-2">{t('aiModel.agreement.intro')}</p>
      <ul className="space-y-2">
        {blocked.map((model) => <BlockedModelItem key={model.id} model={model} tests={tests} />)}
      </ul>
    </div>
  )
}

function BlockedModelItem({ model, tests }: { readonly model: BlockedModel; readonly tests: ModelTests }) {
  const { t } = useTranslation('settings')
  const result = tests.results[model.id]
  const testing = tests.testing.has(model.id)
  return (
    <li data-agreement-model={model.id} data-access={model.status}
      className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-2">
      <div className="min-w-0 text-sm">
        <span className="text-text-strong">{model.label}</span>{' '}
        <span className="badge badge-danger">{t(`aiModel.accessStatus.${model.status}`)}</span>
        <p className="text-xs text-muted">{t(`aiModel.agreement.hint.${model.status}`)}</p>
        {(result !== undefined || testing) && <ModelTestPill result={result} testing={testing} compact />}
      </div>
      <button
        type="button"
        className="btn btn-secondary btn-sm shrink-0 self-start"
        disabled={tests.allProgress !== null || testing}
        onClick={() => void tests.runTest(model.id)}
      >
        <FlaskConical size={14} aria-hidden="true" /> {t('aiModel.test.test')}
      </button>
    </li>
  )
}
