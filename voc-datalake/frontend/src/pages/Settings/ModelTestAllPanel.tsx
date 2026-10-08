/**
 * @fileoverview "Test all models" for the Settings AI models card.
 *
 * One row per allowlisted model: its last test result and its tokens-per-minute
 * quota. The quota column is filled before any test from the cheap capacity
 * overview (GET /settings/model/capacity, no model call), so an admin sees a
 * zero quota without spending a request. The run is sequential (useModelTests).
 */
import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { FlaskConical, Loader2 } from 'lucide-react'
import { api } from '../../api/client'
import ModelTestPill from './ModelTestPill'
import { useModelTestFigures } from './modelTestStatus'
import type { ModelTests } from './useModelTests'

// The capacity overview reads Service Quotas, which the backend caches for 10 minutes too.
const CAPACITY_STALE_MS = 10 * 60 * 1000

interface ModelTestAllPanelProps {
  readonly models: ReadonlyArray<{ readonly id: string; readonly label: string }>
  readonly tests: ModelTests
}

export default function ModelTestAllPanel({ models, tests }: ModelTestAllPanelProps) {
  const { t } = useTranslation('settings')
  const figures = useModelTestFigures()
  const { data: capacity } = useQuery({
    queryKey: ['model-capacity'],
    queryFn: () => api.getModelCapacity(),
    staleTime: CAPACITY_STALE_MS,
  })
  const quotaFor = new Map((capacity ?? []).map((row) => [row.model_id, row.quota]))
  const progress = tests.allProgress

  return (
    <section className="mt-5 pt-4 border-t border-border" aria-labelledby="ai-model-test-all">
      <div className="flex flex-wrap items-center justify-between gap-2 mb-2">
        <div>
          <h3 id="ai-model-test-all" className="text-sm font-semibold text-text-strong">{t('aiModel.test.allTitle')}</h3>
          <p className="text-xs text-muted">{t('aiModel.test.allIntro')}</p>
        </div>
        <button
          type="button"
          className="btn btn-secondary btn-sm"
          disabled={progress !== null || tests.testing.size > 0}
          onClick={() => void tests.runAll(models.map((model) => model.id))}
        >
          {progress
            ? <Loader2 size={14} className="animate-spin" aria-hidden="true" />
            : <FlaskConical size={14} aria-hidden="true" />}
          {progress
            ? t('aiModel.test.allRunning', { current: progress.done + 1, total: progress.total })
            : t('aiModel.test.all')}
        </button>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-xs text-muted">
              <th scope="col" className="py-1.5 pr-3 font-medium">{t('aiModel.test.columns.model')}</th>
              <th scope="col" className="py-1.5 pr-3 font-medium">{t('aiModel.test.columns.status')}</th>
              <th scope="col" className="py-1.5 pr-3 font-medium">{t('aiModel.test.columns.latency')}</th>
              <th scope="col" className="py-1.5 font-medium">{t('aiModel.test.columns.tokensPerMinute')}</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {models.map((model) => {
              const result = tests.results[model.id]
              const quota = result?.quota ?? quotaFor.get(model.id)
              return (
                <tr key={model.id} data-model-id={model.id}>
                  <td className="py-1.5 pr-3 text-text-strong">{model.label}</td>
                  <td className="py-1.5 pr-3">
                    <ModelTestPill result={result} testing={tests.testing.has(model.id)} compact />
                  </td>
                  <td className="py-1.5 pr-3 font-mono text-text">{result ? figures.latency(result.latency_ms) : ''}</td>
                  <td className="py-1.5 font-mono text-text">{figures.tokensPerMinute(quota?.tokens_per_minute)}</td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </section>
  )
}
