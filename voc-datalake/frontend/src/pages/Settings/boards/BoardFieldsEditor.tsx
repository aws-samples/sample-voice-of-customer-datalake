/**
 * @fileoverview The board editor's fields: one switch per catalogue field (on the request form, and
 * on the +1 form), each with a Required box once it is on. Title and description are always asked.
 * @module pages/Settings/boards/BoardFieldsEditor
 */
import { useTranslation } from 'react-i18next'
import Switch from '../../../components/Switch/Switch'
import { LEVEL_FIELD_KEYS } from '../../../api/boardFields'
import type { FieldKey, FieldLevel, FieldSwitch } from '../../../api/boardFields'
import { FIELD_LABEL_KEYS } from './boardCopy'
import { fieldSetting, withFieldSetting } from './boardDraft'
import type { BoardDraft } from './boardDraft'

type Fields = BoardDraft['fields']

function FieldRow({ label, setting, disabled, onChange }: Readonly<{
  label: string; setting: FieldSwitch; disabled: boolean; onChange: (change: Partial<FieldSwitch>) => void
}>) {
  const { t } = useTranslation('settings')
  return (
    <li className="flex flex-wrap items-center justify-between gap-2 py-2">
      <Switch label={label} checked={setting.enabled} disabled={disabled} onChange={(enabled) => onChange({ enabled })} />
      <label className="inline-flex items-center gap-2 text-sm text-text">
        <input type="checkbox" checked={setting.required} disabled={disabled || !setting.enabled}
          aria-label={t('boards.fieldsEditor.requiredLabel', { field: label })}
          onChange={(e) => onChange({ required: e.target.checked })} />
        <span aria-hidden="true">{t('boards.fieldsEditor.required')}</span>
      </label>
    </li>
  )
}

function FieldGroup({ level, keys, draft, disabled, onChange }: Readonly<{
  level: FieldLevel; keys: readonly FieldKey[]; draft: BoardDraft; disabled: boolean; onChange: (fields: Fields) => void
}>) {
  const { t } = useTranslation('settings')
  return (
    <fieldset className="rounded-lg border border-border p-3">
      <legend className="px-1 text-sm font-medium text-text-strong">
        {level === 'request' ? t('boards.fieldsEditor.requestGroup') : t('boards.fieldsEditor.supportGroup')}
      </legend>
      <ul className="divide-y divide-border">
        {keys.map((key) => (
          <FieldRow key={key} label={t(FIELD_LABEL_KEYS[key])} setting={fieldSetting(draft, level, key)} disabled={disabled}
            onChange={(change) => onChange(withFieldSetting(draft.fields, level, key, change))} />
        ))}
      </ul>
    </fieldset>
  )
}

export default function BoardFieldsEditor({ draft, disabled, onChange }: Readonly<{
  draft: BoardDraft; disabled: boolean; onChange: (fields: Fields) => void
}>) {
  const { t } = useTranslation('settings')
  return (
    <section className="space-y-2" aria-labelledby="board-fields-title">
      <h3 id="board-fields-title" className="text-sm font-semibold tracking-tight text-text-strong">{t('boards.fieldsEditor.title')}</h3>
      <p className="text-xs text-muted">{t('boards.fieldsEditor.hint')}</p>
      <div className="grid gap-3 lg:grid-cols-2">
        <FieldGroup level="request" keys={LEVEL_FIELD_KEYS.request} draft={draft} disabled={disabled} onChange={onChange} />
        <FieldGroup level="support" keys={LEVEL_FIELD_KEYS.support} draft={draft} disabled={disabled} onChange={onChange} />
      </div>
    </section>
  )
}
