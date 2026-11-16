/**
 * @fileoverview The form of one app connector or review page (`POST /integrations/{source}/apps`): the manifest's
 * fields, the Radar picker and Save. A review page shows "Read with" (ReviewMethodSelect.tsx: Automatic, Browser only
 * or Bedrock web index only, webReviewMethod.ts) once the deployed plugin offers it; a page read from Amazon
 * Bedrock's web index shows only its own fields and says where its reviews come from, and switching it back to
 * another method shows the browser's fields again.
 *
 * A review page's name says which characters it may hold under its field, and a name the server would refuse
 * (webPageName.ts) says so there and is never sent. A save that failed says why above Save: a new page the
 * workspace already has is "This page is already a source: <its name>" (appSave.ts).
 * @module pages/Scrapers/AppEditorForm
 */
import { Loader2, Save } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ADMIN_ONLY_TITLE } from '../../constants/admin'
import { appCopy } from './appCopy'
import { PluginFieldGrid } from './PluginConfigParts'
import RadarSourcePicker from './RadarSourcePicker'
import ReviewMethodSelect from './ReviewMethodSelect'
import { WEB_REVIEWS_PLUGIN_ID, appField } from './scraper-helpers'
import { isWebPageName } from './webPageName'
import { BEDROCK_WEB_SEARCH, METHOD_FIELD, appFormFields, offersReviewMethods, reviewMethod } from './webReviewMethod'
import type { FieldNote } from './PluginConfigParts'
import type { AppConfig } from './scraper-helpers'
import type { PluginManifest } from '../../plugins/types'
import type { TFunction } from 'i18next'

/** Where a Bedrock web search page's reviews come from, and that each keeps its source link. */
function BedrockNote() {
  const { t } = useTranslation('scrapers')
  return <p className="text-xs text-text p-3 rounded-lg border border-border bg-card">{t('appCard.web.bedrockNote')}</p>
}

/** A review page's name: its hint, and its error while it holds a name the server refuses; nothing for an app. */
function nameNotes(pluginId: string, name: string, t: TFunction<'scrapers'>): { readonly app_name: FieldNote } | undefined {
  if (pluginId !== WEB_REVIEWS_PLUGIN_ID) return undefined
  const invalid = name.trim() !== '' && !isWebPageName(name)
  return { app_name: { hint: t('appCard.web.nameHint'), ...(invalid ? { error: t('appCard.web.nameInvalid') } : {}) } }
}

/** Why the last save failed, said above Save (and read out as it appears). */
function SaveError({ message }: Readonly<{ message: string | null | undefined }>) {
  if (message === null || message === undefined) return null
  return <p role="alert" className="text-sm text-danger break-words [overflow-wrap:anywhere]">{message}</p>
}

export default function AppEditorForm({
  plugin, initialValues, isAdmin, onSave, onCancel, isPending, saveError,
}: {
  readonly plugin: PluginManifest;
  readonly initialValues: AppConfig;
  readonly isAdmin: boolean;
  readonly onSave: (v: AppConfig) => void;
  readonly onCancel: () => void;
  readonly isPending: boolean
  /** Why the last save failed (appSave.ts `appSaveMessage`); null or absent when none did. */
  readonly saveError?: string | null
}) {
  const { t } = useTranslation('scrapers')
  const [values, setValues] = useState<AppConfig>(initialValues)
  const isEditing = appField(initialValues, 'id') !== ''
  const copy = appCopy(plugin.id)
  const fields = appFormFields(plugin, values)
  const hasRequired = fields.filter((f) => f.required === true).every((f) => appField(values, f.key).trim() !== '')
  const notes = nameNotes(plugin.id, appField(values, 'app_name'), t)
  // A name the server refuses is never sent (its field says why).
  const canSave = isAdmin && hasRequired && notes?.app_name.error === undefined
  const isBedrock = reviewMethod(values) === BEDROCK_WEB_SEARCH
  // Titled after where the form was opened from (the Bedrock tile), not after the method chosen since.
  const addTitle = reviewMethod(initialValues) === BEDROCK_WEB_SEARCH ? t('appCard.web.addBedrockPage') : t(copy.addNew)

  return (
    <div className="space-y-4 p-4 border border-accent/30 bg-accent-subtle rounded-lg">
      <h3 className="text-sm font-semibold text-text-strong">{isEditing ? t(copy.edit) : addTitle}</h3>
      {offersReviewMethods(plugin) ? (
        <ReviewMethodSelect plugin={plugin} value={reviewMethod(values)}
          onChange={(method) => setValues((prev) => ({ ...prev, [METHOD_FIELD]: method }))} />
      ) : null}
      {isBedrock ? <BedrockNote /> : null}
      <PluginFieldGrid
        fields={fields}
        values={values}
        notes={notes}
        onChange={(key, v) => setValues((prev) => ({
          ...prev,
          [key]: v,
        }))}
      />
      {/* `radar_brand` (docs/radar.md): this page or app is another brand's, its reviews go to Radar. */}
      <RadarSourcePicker value={appField(values, 'radar_brand')} disabled={!isAdmin}
        onChange={(radarBrand) => setValues((prev) => ({ ...prev, radar_brand: radarBrand }))} />
      <SaveError message={saveError} />
      <div className="flex items-center gap-2">
        <button onClick={() => onSave({ ...values })} disabled={isPending || !canSave} title={isAdmin ? undefined : ADMIN_ONLY_TITLE} className="btn btn-primary">
          {isPending ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />}
          {isEditing ? t('pluginConfig.save') : t(copy.add)}
        </button>
        <button type="button" onClick={onCancel} className="btn btn-secondary">{t('editor.cancel')}</button>
      </div>
    </div>
  )
}
