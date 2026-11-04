/**
 * @fileoverview Administration → General → "Default theme": the start theme every person
 * sees until they pick their own in Account → Preferences (`GET|PUT /settings/appearance`).
 *
 * Admins pick and Save (the card's own button: General's header Save belongs to the brand
 * form); a saved theme also becomes this browser's cached workspace theme at once. Everyone
 * else sees the current pick read-only, like the brand form (the PUT is admin-only server-side).
 *
 * @module pages/Settings/DefaultThemeCard
 */
import { useId, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { Loader2, Lock, Save } from 'lucide-react'
import ThemePicker from '../../components/ThemePicker/ThemePicker'
import StickyActionBar from '../../components/StickyActionBar/StickyActionBar'
import { useThemeNames } from '../../components/ThemePicker/themeNames'
import { appearanceApi, appearanceKey } from '../../api/appearanceApi'
import { COLOR_THEME_IDS, isColorThemeId } from '../../theme/themeCatalog'
import type { ColorThemeId } from '../../theme/themeCatalog'
import { useThemeStore } from '../../theme/themeStore'
import { SECTION_TITLE } from './sectionTitle'
import { SettingsLoading, SettingsNotice } from './SettingsNotice'

interface CardProps {
  readonly apiEndpoint: string
  readonly isAdmin: boolean
}

function useSaveDefaultTheme(onSaved: () => void) {
  const queryClient = useQueryClient()
  const setWorkspaceTheme = useThemeStore((s) => s.setWorkspaceTheme)
  return useMutation({
    mutationFn: (theme: ColorThemeId) => appearanceApi.save(theme),
    onSuccess: (saved) => {
      queryClient.setQueryData(appearanceKey(), saved)
      setWorkspaceTheme(saved.default_theme)
      onSaved()
    },
  })
}

function SaveButton({ pending, disabled, onSave }: Readonly<{ pending: boolean; disabled: boolean; onSave: () => void }>) {
  const { t } = useTranslation('settings')
  return (
    <button type="button" onClick={onSave} disabled={disabled || pending} className="btn btn-primary btn-sm flex items-center gap-1.5">
      {pending ? <Loader2 size={14} className="animate-spin" aria-hidden="true" /> : <Save size={14} aria-hidden="true" />}
      {pending ? t('appearance.saving') : t('appearance.save')}
    </button>
  )
}

export default function DefaultThemeCard({ apiEndpoint, isAdmin }: CardProps) {
  const { t } = useTranslation('settings')
  const labelId = useId()
  const names = useThemeNames()
  const [draft, setDraft] = useState<ColorThemeId | null>(null)
  const query = useQuery({ queryKey: appearanceKey(), queryFn: () => appearanceApi.get(), enabled: apiEndpoint !== '' })
  const save = useSaveDefaultTheme(() => setDraft(null))
  const saved = query.data?.default_theme
  const current = draft ?? saved
  const dirty = draft !== null && draft !== saved

  return (
    <section className="card space-y-4" aria-labelledby={labelId}>
      <div>
        <h2 id={labelId} className={SECTION_TITLE}>{t('appearance.title')}</h2>
        <p className="text-sm text-muted mt-0.5">{t('appearance.hint')}</p>
      </div>
      {isAdmin ? null : (
        <p className="flex items-start gap-2 text-sm text-text bg-info-subtle border border-info/30 p-3 rounded-lg">
          <Lock size={16} className="flex-shrink-0 mt-0.5 text-info" aria-hidden="true" />
          {t('appearance.adminOnlyNotice')}
        </p>
      )}
      {query.isLoading ? <SettingsLoading text={t('appearance.loading')} /> : null}
      {query.isError ? <SettingsNotice text={t('appearance.loadFailed')} /> : null}
      {current === undefined ? null : (
        <ThemePicker
          options={COLOR_THEME_IDS.map((id) => ({ value: id, theme: id, label: names[id] }))}
          value={current}
          labelledBy={labelId}
          readOnly={!isAdmin}
          onChange={(value) => { if (isColorThemeId(value)) setDraft(value) }}
        />
      )}
      {save.isError ? <SettingsNotice text={t('appearance.saveFailed')} /> : null}
      {isAdmin && current !== undefined ? (
        <StickyActionBar variant="inline" className="flex justify-end py-2">
          <SaveButton pending={save.isPending} disabled={!dirty} onSave={() => { if (draft !== null) save.mutate(draft) }} />
        </StickyActionBar>
      ) : null}
    </section>
  )
}
