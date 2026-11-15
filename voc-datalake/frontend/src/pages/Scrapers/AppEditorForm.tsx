/**
 * @fileoverview The form of one app connector or review page (`POST /integrations/{source}/apps`): the manifest's
 * fields, the Radar picker and Save. A review page read from Amazon Bedrock's web search index (`method`,
 * webReviewMethod.ts) shows only its own fields and says where its reviews come from; the method itself is kept
 * from the values it opened with, never a field.
 * @module pages/Scrapers/AppEditorForm
 */
import { Loader2, Save } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ADMIN_ONLY_TITLE } from '../../constants/admin'
import { appCopy } from './appCopy'
import { PluginFieldGrid } from './PluginConfigParts'
import RadarSourcePicker from './RadarSourcePicker'
import { appField } from './scraper-helpers'
import { BEDROCK_WEB_SEARCH, appFormFields, reviewMethod } from './webReviewMethod'
import type { AppConfig } from './scraper-helpers'
import type { PluginManifest } from '../../plugins/types'

/** Where a Bedrock web search page's reviews come from, and that each keeps its source link. */
function BedrockNote() {
  const { t } = useTranslation('scrapers')
  return <p className="text-xs text-text p-3 rounded-lg border border-border bg-card">{t('appCard.web.bedrockNote')}</p>
}

export default function AppEditorForm({
  plugin, initialValues, isAdmin, onSave, onCancel, isPending,
}: {
  readonly plugin: PluginManifest;
  readonly initialValues: AppConfig;
  readonly isAdmin: boolean;
  readonly onSave: (v: AppConfig) => void;
  readonly onCancel: () => void;
  readonly isPending: boolean
}) {
  const { t } = useTranslation('scrapers')
  const [values, setValues] = useState<AppConfig>(initialValues)
  const isEditing = appField(initialValues, 'id') !== ''
  const copy = appCopy(plugin.id)
  const fields = appFormFields(plugin, values)
  const hasRequired = fields.filter((f) => f.required === true).every((f) => appField(values, f.key).trim() !== '')
  const isBedrock = reviewMethod(values) === BEDROCK_WEB_SEARCH
  const addTitle = isBedrock ? t('appCard.web.addBedrockPage') : t(copy.addNew)

  return (
    <div className="space-y-4 p-4 border border-accent/30 bg-accent-subtle rounded-lg">
      <h3 className="text-sm font-semibold text-text-strong">{isEditing ? t(copy.edit) : addTitle}</h3>
      {isBedrock ? <BedrockNote /> : null}
      <PluginFieldGrid
        fields={fields}
        values={values}
        onChange={(key, v) => setValues((prev) => ({
          ...prev,
          [key]: v,
        }))}
      />
      {/* `radar_brand` (docs/radar.md): this page or app is another brand's, its reviews go to Radar. */}
      <RadarSourcePicker value={appField(values, 'radar_brand')} disabled={!isAdmin}
        onChange={(radarBrand) => setValues((prev) => ({ ...prev, radar_brand: radarBrand }))} />
      <div className="flex items-center gap-2">
        <button onClick={() => onSave({ ...values })} disabled={isPending || !hasRequired || !isAdmin} title={isAdmin ? undefined : ADMIN_ONLY_TITLE} className="btn btn-primary">
          {isPending ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />}
          {isEditing ? t('pluginConfig.save') : t(copy.add)}
        </button>
        <button type="button" onClick={onCancel} className="btn btn-secondary">{t('editor.cancel')}</button>
      </div>
    </div>
  )
}
