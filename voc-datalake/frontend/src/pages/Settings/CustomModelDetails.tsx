/**
 * @fileoverview What a surface row of the Settings AI models card says about one of the deployment's own models
 * (7.65.00, `-c customModels`, docs/deployment.md "Bring your own model"), shown while the row's draft resolves to
 * it: a "Your model" badge (and EU residency when the deployment declared and the synth checked it), where its
 * inference runs and through what (an in-Region Bedrock model, an inference profile or an imported model), its
 * price per million tokens, the note that the prompts are tuned for Claude, the cold-start note of an imported model,
 * and its two checks: a JSON object (`probe: json`) and, when it takes tools, a tool call (`probe: tools`), each
 * with its own result. The row's Test stays the basic one, and the save confirmation reads that one only.
 */
import { useTranslation } from 'react-i18next'
import { Braces, Wrench } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import ModelTestPill from './ModelTestPill'
import { testKey, type ModelTests } from './useModelTests'
import type { CustomModelRow } from '../../api/modelSettingsSchema'
import type { ModelTestProbe } from '../../api/modelTestSchema'
import { Tooltip } from '../../components/Tooltip/Tooltip'
import { formatCount } from '../../utils/numberFormat'

/** A check this card offers, beside the basic Test. */
type CheckProbe = Exclude<ModelTestProbe, 'basic'>

interface CheckMeta {
  readonly icon: LucideIcon
  readonly labelKey: string
  readonly titleKey: string
  readonly resultKey: string
}

const CHECKS: Readonly<Record<CheckProbe, CheckMeta>> = {
  json: {
    icon: Braces, labelKey: 'aiModel.test.probe.json', titleKey: 'aiModel.test.probe.jsonTitle',
    resultKey: 'aiModel.test.probe.jsonResult',
  },
  tools: {
    icon: Wrench, labelKey: 'aiModel.test.probe.tools', titleKey: 'aiModel.test.probe.toolsTitle',
    resultKey: 'aiModel.test.probe.toolsResult',
  },
}

const SOURCE_KEYS: Readonly<Record<CustomModelRow['source'], string>> = {
  model: 'aiModel.custom.source.model',
  profile: 'aiModel.custom.source.profile',
  imported: 'aiModel.custom.source.imported',
}

interface CustomModelDetailsProps {
  readonly model: CustomModelRow
  readonly tests: ModelTests
  /** "Test all" is running: every check waits for it. */
  readonly busy: boolean
}

export default function CustomModelDetails({ model, tests, busy }: CustomModelDetailsProps) {
  const { t, i18n } = useTranslation('settings')
  const source = t(SOURCE_KEYS[model.source])
  const residency = model.regions.length > 0
    ? t('aiModel.custom.runsIn', { regions: model.regions.join(', '), source })
    : t('aiModel.custom.runsAnywhere', { source })
  const checks: CheckProbe[] = model.capabilities.tools ? ['json', 'tools'] : ['json']
  return (
    <div className="flex flex-col gap-1.5" data-custom-model={model.key}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="badge badge-accent">{t('aiModel.custom.badge')}</span>
        {model.eu && <span className="badge badge-info">{t('aiModel.custom.euBadge')}</span>}
        <span className="text-xs text-muted">{residency}</span>
      </div>
      <p className="text-xs text-muted">
        {t('aiModel.custom.price', { in: formatCount(model.price.in, i18n.language), out: formatCount(model.price.out, i18n.language) })}
      </p>
      <p className="text-xs text-warn">{t('aiModel.custom.claudeTuned')}</p>
      {model.kind === 'imported' && <p className="text-xs text-muted">{t('aiModel.custom.coldStart')}</p>}
      <div className="flex flex-wrap items-center gap-3">
        {checks.map((probe) => (
          <ModelCheck key={probe} model={model} probe={probe} tests={tests} busy={busy} />
        ))}
      </div>
    </div>
  )
}

interface ModelCheckProps extends CustomModelDetailsProps {
  readonly probe: CheckProbe
}

/** One check's button and, once it ran (or while it runs), its result under the check's name. */
function ModelCheck({ model, probe, tests, busy }: ModelCheckProps) {
  const { t } = useTranslation('settings')
  const key = testKey(model.id, probe)
  const { icon: Icon, labelKey, titleKey, resultKey } = CHECKS[probe]
  const result = tests.results[key]
  const testing = tests.testing.has(key)
  return (
    <div className="flex flex-wrap items-center gap-2" data-probe={probe}>
      <Tooltip kind="description" content={t(titleKey, { model: model.label })}>
        <button
          type="button"
          className="btn btn-secondary btn-sm"
          disabled={busy || testing}
          onClick={() => void tests.runTest(model.id, probe)}
        >
          <Icon size={14} aria-hidden="true" /> {t(labelKey)}
        </button>
      </Tooltip>
      {(result !== undefined || testing) && (
        <span className="inline-flex items-start gap-1.5 min-w-0">
          <span className="text-xs text-muted shrink-0">{t(resultKey)}</span>
          <ModelTestPill result={result} testing={testing} />
        </span>
      )}
    </div>
  )
}
