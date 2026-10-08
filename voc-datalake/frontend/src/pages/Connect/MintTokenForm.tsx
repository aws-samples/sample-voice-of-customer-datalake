/**
 * @fileoverview Create a personal token for the global MCP endpoint: name,
 * scope (read-only / read-write), lifetime, and an optional project pin. The
 * raw credential is shown ONCE, right here, after minting.
 *
 * Scope has no pre-selection, like the per-project mint form: the backend
 * REQUIRES it so the laziest request cannot produce the wider credential.
 *
 * @module pages/Connect/MintTokenForm
 */
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { KeyRound, TriangleAlert } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { connectApi, CONNECT_TOKENS_KEY } from '../../api/connectApi'
import { CONNECT_SCOPES, DEFAULT_EXPIRY_DAYS, EXPIRY_CHOICES, MAX_TOKEN_NAME_LENGTH, isConnectScope } from '../../api/connectSchema'
import { LabeledField } from '../../components/LabeledField/LabeledField'
import { useCopyToClipboard } from '../../hooks/useCopyToClipboard'
import { CopyButton } from './CopyButton'
import type { ConnectScope, MintResponse } from '../../api/connectSchema'
import StickyActionBar from '../../components/StickyActionBar/StickyActionBar'

export interface ProjectChoice {
  readonly project_id: string
  readonly name: string
}

function NewTokenBanner({ minted, onDismiss }: Readonly<{ minted: MintResponse; onDismiss: () => void }>) {
  const { t } = useTranslation('common')
  const { copy, copiedKey } = useCopyToClipboard()
  return (
    <div role="status" className="rounded-md border border-warn bg-warn-subtle p-3 space-y-2">
      <p className="flex items-center gap-2 text-sm font-medium text-text-strong">
        <TriangleAlert size={16} className="text-warn" aria-hidden="true" /> {t('connect.newTokenTitle')}
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <code className="flex-1 min-w-0 break-all rounded-sm bg-bg-hover px-2 py-1 text-[12px]" data-testid="connect-new-token">{minted.token}</code>
        <CopyButton text={minted.token} copyKey="token" copiedKey={copiedKey} onCopy={copy} />
      </div>
      <p className="text-[12px] text-muted">{t('connect.newTokenBody')}</p>
      <button type="button" className="btn btn-ghost btn-sm" onClick={onDismiss}>{t('connect.newTokenDone')}</button>
    </div>
  )
}

function ScopeChoice({ scope, onChange, canRunAgents }: Readonly<{
  scope: ConnectScope | null; onChange: (scope: ConnectScope) => void; canRunAgents: boolean
}>) {
  const { t } = useTranslation('common')
  return (
    <fieldset className="space-y-2">
      <legend className="text-[12px] font-medium text-muted">{t('connect.scopeLabel')}</legend>
      {CONNECT_SCOPES.map((value) => (
        <label key={value} className="flex items-start gap-2 text-sm text-text">
          <input type="radio" name="connect-scope" value={value} checked={scope === value} className="mt-1"
            onChange={(event) => { if (isConnectScope(event.target.value)) onChange(event.target.value) }} />
          <span>
            <span className="font-medium text-text-strong">{t(`connect.scope.${value}`)}</span>
            <span className="block text-[12px] text-muted">
              {t(`connect.scopeHint.${value}`)}
              {value === 'write' && canRunAgents ? ` ${t('connect.scopeHint.writeAdmin')}` : ''}
            </span>
          </span>
        </label>
      ))}
    </fieldset>
  )
}

export function MintTokenForm({ projects, initialProjectId, canMintAgentRunner }: Readonly<{
  projects: readonly ProjectChoice[]; initialProjectId: string; canMintAgentRunner: boolean
}>) {
  const { t } = useTranslation('common')
  const queryClient = useQueryClient()
  const [name, setName] = useState('')
  const [scope, setScope] = useState<ConnectScope | null>(null)
  const [days, setDays] = useState<number>(DEFAULT_EXPIRY_DAYS)
  const [projectId, setProjectId] = useState(initialProjectId)
  const [minted, setMinted] = useState<MintResponse | null>(null)

  const mint = useMutation({
    mutationFn: () => connectApi.mintToken({
      name: name.trim(), scope: scope ?? 'read', expires_in_days: days, ...(projectId ? { project_id: projectId } : {}),
    }),
    onSuccess: (response) => {
      setMinted(response)
      setName('')
      setScope(null)
      void queryClient.invalidateQueries({ queryKey: CONNECT_TOKENS_KEY })
    },
  })
  const canSubmit = name.trim().length > 0 && scope !== null && !mint.isPending

  return (
    <section className="card space-y-4" aria-labelledby="connect-mint-title">
      <h2 id="connect-mint-title" className="flex items-center gap-2 text-base font-semibold text-text-strong">
        <KeyRound size={16} className="text-accent-text" aria-hidden="true" /> {t('connect.mintTitle')}
      </h2>
      {minted && <NewTokenBanner minted={minted} onDismiss={() => setMinted(null)} />}
      <form className="space-y-4" onSubmit={(event) => { event.preventDefault(); if (canSubmit) mint.mutate() }}>
        <LabeledField label={t('connect.nameLabel')} hint={t('connect.nameHint')}>
          {(id) => (
            <input id={id} className="input w-full" value={name} maxLength={MAX_TOKEN_NAME_LENGTH}
              onChange={(event) => setName(event.target.value)} placeholder={t('connect.namePlaceholder')} />
          )}
        </LabeledField>
        <ScopeChoice scope={scope} onChange={setScope} canRunAgents={canMintAgentRunner} />
        <div className="grid gap-4 sm:grid-cols-2">
          <LabeledField label={t('connect.expiryLabel')}>
            {(id) => (
              <select id={id} className="input w-full" value={days} onChange={(event) => setDays(Number(event.target.value))}>
                {EXPIRY_CHOICES.map((choice) => (
                  <option key={choice} value={choice}>{t('connect.expiryDays', { count: choice })}</option>
                ))}
              </select>
            )}
          </LabeledField>
          <LabeledField label={t('connect.projectLabel')} hint={t('connect.projectHint')}>
            {(id) => (
              <select id={id} className="input w-full" value={projectId} onChange={(event) => setProjectId(event.target.value)}>
                <option value="">{t('connect.projectAll')}</option>
                {projects.map((project) => (
                  <option key={project.project_id} value={project.project_id}>{project.name || project.project_id}</option>
                ))}
              </select>
            )}
          </LabeledField>
        </div>
        {mint.isError && <p role="alert" className="text-sm text-danger">{t('connect.mintFailed')}</p>}
        <StickyActionBar variant="inline" className="py-2">
          <button type="submit" className="btn btn-primary" disabled={!canSubmit}>
            {mint.isPending ? t('connect.minting') : t('connect.mint')}
          </button>
        </StickyActionBar>
      </form>
    </section>
  )
}
