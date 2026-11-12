/**
 * @fileoverview Administration → General → "Default theme": the start theme every person
 * sees until they pick their own in Account → Preferences (`GET|PUT /settings/appearance`).
 *
 * Platform admins pick and Save (the card's own button: General's header Save belongs to the
 * brand form); a saved theme also becomes this browser's cached workspace theme at once. An unsaved
 * pick is under the shared unsaved-changes guard: leaving the page or switching tabs asks
 * Save / Discard / Cancel. Everyone else, a plain administrator included, sees the current pick
 * read-only (the PUT is platform-admin-only server-side, checked live: one colour scheme for the
 * whole deployment, docs/multi-workspace.md).
 *
 * @module pages/Settings/DefaultThemeCard
 */
import { useId, useState } from 'react'
import type { Location } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { Loader2, Save } from 'lucide-react'
import ThemePicker from '../../components/ThemePicker/ThemePicker'
import StickyActionBar from '../../components/StickyActionBar/StickyActionBar'
import { useUnsavedChangesGuard } from '../../components/UnsavedChangesGuard/useUnsavedChangesGuard'
import { useThemeNames } from '../../components/ThemePicker/themeNames'
import { appearanceApi, appearanceKey } from '../../api/appearanceApi'
import { messageKeyForStatus } from '../../api/apiErrorStatus'
import { ignoreRejection } from '../../lib/rejections'
import { COLOR_THEME_IDS, isColorThemeId } from '../../theme/themeCatalog'
import type { ColorThemeId } from '../../theme/themeCatalog'
import { useThemeStore } from '../../theme/themeStore'
import { SECTION_TITLE } from './sectionTitle'
import { ReadOnlyNotice, SettingsLoading, SettingsNotice } from './SettingsNotice'

/** A platform-admin membership revoked since sign-in: the server checks it live (403), and a retry cannot pass. */
const SAVE_ERROR_KEYS = [{ status: 403, messageKey: 'appearance.adminOnlyNotice' }] as const
const SAVE_FAILED = { messageKey: 'appearance.saveFailed' } as const

interface CardProps {
  readonly apiEndpoint: string
  /** A platform admin's (`useIsPlatformAdmin`): one theme for the whole deployment; everyone else views it. */
  readonly canEdit: boolean
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

/** The platform admin's Save row, with the save error above it (`error`: the failed save's, else null). */
function DefaultThemeSaveBar({ dirty, pending, error, onSave }: Readonly<{
  dirty: boolean
  pending: boolean
  error: unknown
  onSave: () => void
}>) {
  const { t } = useTranslation('settings')
  return (
    <>
      {error ? <SettingsNotice text={t(messageKeyForStatus(error, SAVE_ERROR_KEYS, SAVE_FAILED))} /> : null}
      <StickyActionBar variant="inline" className="flex justify-end py-2">
        <button type="button" disabled={!dirty || pending} className="btn btn-primary btn-sm flex items-center gap-1.5" onClick={onSave}>
          {pending ? <Loader2 size={14} className="animate-spin" aria-hidden="true" /> : <Save size={14} aria-hidden="true" />}
          {pending ? t('appearance.saving') : t('appearance.save')}
        </button>
      </StickyActionBar>
    </>
  )
}

/** What can unmount the card and lose a pick: leaving /admin, or switching its `?tab=` (not an overlay like `?review=`). */
function losesTheCard(current: Location, next: Location): boolean {
  const tab = (search: string) => new URLSearchParams(search).get('tab')
  return current.pathname !== next.pathname || tab(current.search) !== tab(next.search)
}

/** The admin's unsaved pick, its save, and the guard that asks before it is lost. */
function useDefaultThemeDraft(saved: ColorThemeId | undefined, canEdit: boolean) {
  const [draft, setDraft] = useState<ColorThemeId | null>(null)
  const save = useSaveDefaultTheme(() => setDraft(null))
  const dirty = canEdit && draft !== null && draft !== saved
  const saveDraft = async (): Promise<boolean> => {
    if (draft === null) return false
    await save.mutateAsync(draft)
    return true
  }
  const guard = useUnsavedChangesGuard({ dirty, onSave: saveDraft, onDiscard: () => setDraft(null), shouldBlock: losesTheCard })
  return { draft, setDraft, dirty, save, saveDraft, guard }
}

export default function DefaultThemeCard({ apiEndpoint, canEdit }: CardProps) {
  const { t } = useTranslation('settings')
  const labelId = useId()
  const names = useThemeNames()
  const query = useQuery({ queryKey: appearanceKey(), queryFn: () => appearanceApi.get(), enabled: apiEndpoint !== '' })
  const saved = query.data?.default_theme
  const { draft, setDraft, dirty, save, saveDraft, guard } = useDefaultThemeDraft(saved, canEdit)
  const current = draft ?? saved

  // Without an API endpoint the read never runs (a local build before setup): no card at all,
  // rather than a title over nothing.
  if (apiEndpoint === '') return null

  return (
    <section className="card space-y-4" aria-labelledby={labelId}>
      {guard.dialog}
      <div>
        <h2 id={labelId} className={SECTION_TITLE}>{t('appearance.title')}</h2>
        <p className="text-sm text-muted mt-0.5">{t('appearance.hint')}</p>
      </div>
      {canEdit ? null : <ReadOnlyNotice text={t('appearance.adminOnlyNotice')} />}
      {query.isLoading ? <SettingsLoading text={t('appearance.loading')} /> : null}
      {query.isError ? <SettingsNotice text={t('appearance.loadFailed')} /> : null}
      {current === undefined ? null : (
        <ThemePicker
          options={COLOR_THEME_IDS.map((id) => ({ value: id, theme: id, label: names[id] }))}
          value={current}
          labelledBy={labelId}
          readOnly={!canEdit}
          onChange={(value) => { if (isColorThemeId(value)) setDraft(value) }}
        />
      )}
      {canEdit && current !== undefined ? (
        <DefaultThemeSaveBar dirty={dirty} pending={save.isPending} error={save.isError ? save.error : null}
          onSave={() => { saveDraft().catch(ignoreRejection) }} />
      ) : null}
    </section>
  )
}
