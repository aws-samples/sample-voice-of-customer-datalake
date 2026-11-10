/**
 * @fileoverview Administration → Sources → Radar, "Exa (second search index)" (docs/radar.md):
 * whether an Exa API key is stored, a password box to store or replace it
 * (PUT /radar/settings/exa-key) and Remove behind a confirm (DELETE). The key is never shown
 * back: the box is cleared once it is saved and the server only ever says `exa_configured`.
 * @module pages/Settings/RadarExaCard
 */
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { CheckCircle2, CircleDashed, KeyRound, Save, Trash2 } from 'lucide-react'
import { useId, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { radarApi, radarKeys } from '../../api/radarApi'
import ConfirmModal from '../../components/ConfirmModal/ConfirmModal'
import { serverReason } from '../../lib/errors'
import StickyActionBar from '../../components/StickyActionBar/StickyActionBar'
import type { RadarOverview } from '../../api/radarSchema'

/** radar_handler's key rule: 8-200 letters, digits, '-' or '_'. */
const EXA_KEY = /^[A-Za-z0-9_-]{8,200}$/u

/** Store the answer's `exa_configured` on the overview both this card and the Radar page read. */
function useExaKeyMutation<T>(run: (input: T) => Promise<boolean>, onDone: () => void) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: run,
    onSuccess: (configured: boolean) => {
      queryClient.setQueryData<RadarOverview>(radarKeys.overview(), (old) =>
        (old === undefined ? old : { ...old, settings: { ...old.settings, exa_configured: configured } }))
      onDone()
    },
  })
}

type ExaMutation<T> = ReturnType<typeof useExaKeyMutation<T>>

function ExaStatus({ configured }: Readonly<{ configured: boolean }>) {
  const { t } = useTranslation('radar')
  return configured
    ? <span className="badge badge-ok"><CheckCircle2 size={12} aria-hidden="true" />{t('exa.configured')}</span>
    : <span className="badge badge-muted"><CircleDashed size={12} aria-hidden="true" />{t('exa.notConfigured')}</span>
}

function Feedback({ save, remove, invalid }: Readonly<{
  save: ExaMutation<string>; remove: ExaMutation<void>; invalid: boolean
}>) {
  const { t } = useTranslation('radar')
  if (invalid) return <p role="alert" className="text-xs text-danger">{t('exa.invalidKey')}</p>
  if (save.isError) return <p role="alert" className="text-xs text-danger">{t('exa.saveFailed')} {serverReason(save.error) ?? ''}</p>
  if (remove.isError) return <p role="alert" className="text-xs text-danger">{t('exa.removeFailed')} {serverReason(remove.error) ?? ''}</p>
  if (save.isSuccess) return <p role="status" className="text-xs text-ok">{t('exa.saved')}</p>
  if (remove.isSuccess) return <p role="status" className="text-xs text-ok">{t('exa.removed')}</p>
  return null
}

export default function RadarExaCard({ configured }: Readonly<{ configured: boolean }>) {
  const { t } = useTranslation('radar')
  const inputId = useId()
  const [key, setKey] = useState('')
  const [tried, setTried] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const save = useExaKeyMutation((apiKey: string) => radarApi.saveExaKey(apiKey), () => { setKey(''); setTried(false) })
  const remove = useExaKeyMutation<void>(() => radarApi.removeExaKey(), () => setConfirming(false))
  const trimmed = key.trim()
  const invalid = tried && !EXA_KEY.test(trimmed)
  const submit = () => {
    setTried(true)
    remove.reset()
    if (EXA_KEY.test(trimmed)) save.mutate(trimmed)
  }
  return (
    <section aria-labelledby="radar-exa" className="rounded-lg border border-border p-4 space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 id="radar-exa" className="text-sm font-semibold tracking-tight text-text-strong">{t('exa.title')}</h3>
        <ExaStatus configured={configured} />
      </div>
      <p className="text-xs text-muted max-w-prose">{t('exa.description')}</p>
      <form className="flex flex-col gap-2 sm:flex-row sm:items-end" onSubmit={(e) => { e.preventDefault(); submit() }}>
        <div className="flex-1 min-w-0">
          <label htmlFor={inputId} className="flex items-center gap-1.5 text-xs font-medium text-text mb-1">
            <KeyRound size={12} className="text-muted" aria-hidden="true" />{t('exa.keyLabel')}
          </label>
          <input id={inputId} type="password" autoComplete="off" spellCheck={false} className="input font-mono" value={key}
            placeholder={configured ? t('exa.replacePlaceholder') : t('exa.placeholder')} aria-invalid={invalid}
            onChange={(e) => setKey(e.target.value)} />
        </div>
        <StickyActionBar variant="inline" className="flex flex-wrap gap-2">
          <button type="submit" className="btn btn-primary btn-sm" disabled={trimmed === '' || save.isPending}>
            <Save size={14} aria-hidden="true" />{t('exa.save')}
          </button>
          {configured ? (
            <button type="button" className="btn btn-ghost btn-sm hover:text-danger" onClick={() => { save.reset(); setConfirming(true) }}>
              <Trash2 size={14} aria-hidden="true" />{t('exa.remove')}
            </button>
          ) : null}
        </StickyActionBar>
      </form>
      <Feedback save={save} remove={remove} invalid={invalid} />
      <ConfirmModal isOpen={confirming} variant="danger" title={t('exa.removeTitle')} message={t('exa.removeMessage')}
        confirmLabel={t('exa.remove')} isLoading={remove.isPending} onConfirm={() => remove.mutate()} onCancel={() => setConfirming(false)} />
    </section>
  )
}
