/**
 * @fileoverview The read-only "Image generation (persona avatars)" row of the Settings AI
 * models card (lambda/shared/image_model_status.py).
 *
 * The image model is fixed by the deployment (avatar-generation.json), not a picker choice, so
 * the row shows facts: the model and its region, the account's access to it (from
 * GetFoundationModelAvailability, with a short fix hint), its requests-per-minute quota, and a
 * Test button that generates ONE small image (POST /settings/model/test; nothing stored). The
 * test costs a few cents, unlike a text-model test, so "Test all models" leaves it out.
 */
import { useTranslation } from 'react-i18next'
import { CheckCircle2, CircleHelp, FlaskConical, ImageIcon, Lock, MapPinOff, ShieldAlert } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import ModelTestPill from './ModelTestPill'
import { useModelCapacity } from './useModelCapacity'
import type { ModelTests } from './useModelTests'
import type { ImageAccessStatus, ImageModelCapacity, ImageModelInfo } from '../../api/imageModelSchema'
import type { Tone } from '../../theme/tones'

const ACCESS_META: Record<ImageAccessStatus, { readonly tone: Tone; readonly icon: LucideIcon }> = {
  available: { tone: 'ok', icon: CheckCircle2 },
  no_access: { tone: 'danger', icon: Lock },
  not_subscribed: { tone: 'danger', icon: ShieldAlert },
  not_in_region: { tone: 'muted', icon: MapPinOff },
  unknown: { tone: 'muted', icon: CircleHelp },
}

interface ImageModelRowProps {
  readonly info: ImageModelInfo
  readonly tests: ModelTests
}

export default function ImageModelRow({ info, tests }: ImageModelRowProps) {
  const { t } = useTranslation('settings')
  const { data: capacity } = useModelCapacity()
  const image = capacity?.image ?? null
  const label = info.label || info.id
  const result = tests.results[info.id]
  const testing = tests.testing.has(info.id)
  const busy = tests.allProgress !== null || testing

  return (
    <section className="mt-5 pt-4 border-t border-border" aria-labelledby="ai-model-image" data-image-model={info.id}>
      <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-2">
        <div className="min-w-0">
          <h3 id="ai-model-image" className="text-sm font-semibold text-text-strong flex items-center gap-1.5">
            <ImageIcon size={16} className="text-accent" aria-hidden="true" /> {t('aiModel.image.title')}
          </h3>
          <p className="text-xs text-muted">{t('aiModel.image.description')}</p>
        </div>
        <button
          type="button"
          className="btn btn-secondary btn-sm shrink-0 self-start"
          disabled={busy}
          title={t('aiModel.image.testTitle', { model: label })}
          onClick={() => void tests.runTest(info.id)}
        >
          <FlaskConical size={14} aria-hidden="true" /> {t('aiModel.test.test')}
        </button>
      </div>
      <dl className="mt-2 grid grid-cols-1 sm:grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-sm">
        <dt className="text-muted">{t('aiModel.image.model')}</dt>
        <dd className="text-text-strong">{label} <span className="font-mono text-xs text-muted">{info.id}</span></dd>
        <dt className="text-muted">{t('aiModel.image.region')}</dt>
        <dd className="font-mono text-text">{info.region}</dd>
        <dt className="text-muted">{t('aiModel.image.access')}</dt>
        <dd><AccessStatus image={image} /></dd>
        <dt className="text-muted">{t('aiModel.image.quota')}</dt>
        <dd className="font-mono text-text"><QuotaText image={image} /></dd>
      </dl>
      {!info.avatars_enabled && <p className="text-xs text-warn mt-2">{t('aiModel.image.avatarsOff')}</p>}
      {(result !== undefined || testing) && (
        <div className="mt-2">
          <ModelTestPill result={result} testing={testing} />
        </div>
      )}
    </section>
  )
}

function AccessStatus({ image }: { readonly image: ImageModelCapacity | null }) {
  const { t } = useTranslation('settings')
  const status: ImageAccessStatus = image?.access.status ?? 'unknown'
  const meta = ACCESS_META[status]
  const Icon = meta.icon
  return (
    <span className="inline-flex flex-col gap-0.5 min-w-0" data-access={status}>
      <span className={`badge badge-${meta.tone} inline-flex items-center gap-1 self-start`}>
        <Icon size={12} aria-hidden="true" /> {t(`aiModel.accessStatus.${status}`)}
      </span>
      {status !== 'available' && <span className="text-xs text-muted">{t(`aiModel.image.hint.${status}`)}</span>}
    </span>
  )
}

function QuotaText({ image }: { readonly image: ImageModelCapacity | null }) {
  const { t } = useTranslation('settings')
  if (image?.quota) {
    const value = t('aiModel.image.requestsPerMinute', { count: image.quota.value })
    return image.quota_state === 'stale' ? <>{value} <span className="text-muted">({t('aiModel.test.quotaStale')})</span></> : <>{value}</>
  }
  return <>{image?.quota_state === 'pending' ? t('aiModel.image.quotaPending') : t('aiModel.test.quotaUnknown')}</>
}
