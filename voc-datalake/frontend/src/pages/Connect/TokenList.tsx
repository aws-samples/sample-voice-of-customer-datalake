/**
 * @fileoverview "My tokens": every global MCP token I minted (active, expired,
 * revoked), with revoke and each token's audit log of tool calls (tool, time,
 * project, outcome — the backend never records arguments or content).
 *
 * @module pages/Connect/TokenList
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { format } from 'date-fns'
import { ChevronDown, ChevronRight, ShieldOff } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { clsx } from 'clsx'
import { connectApi, CONNECT_TOKENS_KEY } from '../../api/connectApi'
import ConfirmModal from '../../components/ConfirmModal/ConfirmModal'
import type { AuditOutcome, ConnectToken, TokenStatus } from '../../api/connectSchema'

const STATUS_CLASS: Record<TokenStatus, string> = {
  active: 'badge-ok',
  expired: 'badge-warn',
  revoked: 'badge-danger',
}
const OUTCOME_CLASS: Record<AuditOutcome, string> = {
  ok: 'text-ok', error: 'text-warn', denied: 'text-danger', failed: 'text-danger',
}

function when(iso: string | undefined): string {
  if (!iso) return '—'
  const date = new Date(iso)
  return Number.isNaN(date.getTime()) ? '—' : format(date, 'yyyy-MM-dd HH:mm')
}

function TokenAudit({ tokenId }: Readonly<{ tokenId: string }>) {
  const { t } = useTranslation('common')
  const { data, isLoading, isError } = useQuery({
    queryKey: [...CONNECT_TOKENS_KEY, tokenId],
    queryFn: () => connectApi.tokenDetail(tokenId),
  })
  if (isLoading) return <p className="text-[12px] text-muted">{t('connect.auditLoading')}</p>
  if (isError || !data) return <p role="alert" className="text-[12px] text-danger">{t('connect.auditFailed')}</p>
  if (data.events.length === 0) return <p className="text-[12px] text-muted">{t('connect.auditEmpty')}</p>
  return (
    <table className="w-full text-[12px]">
      <caption className="sr-only">{t('connect.auditTitle')}</caption>
      <thead>
        <tr className="text-left text-muted">
          <th scope="col" className="py-1 pr-2 font-medium">{t('connect.auditTime')}</th>
          <th scope="col" className="py-1 pr-2 font-medium">{t('connect.auditTool')}</th>
          <th scope="col" className="py-1 pr-2 font-medium">{t('connect.auditProject')}</th>
          <th scope="col" className="py-1 font-medium">{t('connect.auditOutcomeLabel')}</th>
        </tr>
      </thead>
      <tbody>
        {data.events.map((event) => (
          <tr key={`${event.at}-${event.tool}`} className="border-t border-border">
            <td className="py-1 pr-2 whitespace-nowrap">{when(event.at)}</td>
            <td className="py-1 pr-2 font-mono">{event.tool}</td>
            <td className="py-1 pr-2">{event.project_id ?? '—'}</td>
            <td className={clsx('py-1', OUTCOME_CLASS[event.outcome])}>{t(`connect.auditOutcome.${event.outcome}`)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

function Fact({ label, value }: Readonly<{ label: string; value: string }>) {
  return <div><dt className="inline">{label}: </dt><dd className="inline text-text">{value}</dd></div>
}

function TokenRow({ token, projectName, onRevoke }: Readonly<{
  token: ConnectToken; projectName: string | undefined; onRevoke: (token: ConnectToken) => void
}>) {
  const { t } = useTranslation('common')
  const [open, setOpen] = useState(false)
  return (
    <li className="py-3 space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" className="btn btn-ghost btn-sm" aria-expanded={open} onClick={() => setOpen(!open)}
          aria-label={t('connect.toggleAudit', { name: token.name })}>
          {open ? <ChevronDown size={14} aria-hidden="true" /> : <ChevronRight size={14} aria-hidden="true" />}
        </button>
        <span className="font-medium text-text-strong">{token.name || token.token_id}</span>
        {/* Design-system badges (12px pills): these were hand-rolled 11px chips (D-READ). */}
        <span className={clsx('badge', STATUS_CLASS[token.status])}>
          {t(`connect.status.${token.status}`)}
        </span>
        <span className="badge badge-muted">{t(`connect.scope.${token.scope}`)}</span>
        {token.can_run_agents && <span className="badge badge-aim">{t('connect.runsAgents')}</span>}
        <span className="flex-1" />
        {token.status === 'active' && (
          <button type="button" className="btn btn-secondary btn-sm" onClick={() => onRevoke(token)}>
            <ShieldOff size={14} aria-hidden="true" /> {t('connect.revoke')}
          </button>
        )}
      </div>
      <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-[12px] text-muted sm:grid-cols-4">
        <Fact label={t('connect.projectColumn')}
          value={token.project_id ? (projectName ?? token.project_id) : t('connect.projectAll')} />
        <Fact label={t('connect.expires')} value={when(token.expires_at)} />
        <Fact label={t('connect.lastUsed')} value={token.last_used_at ? when(token.last_used_at) : t('connect.never')} />
        <Fact label={t('connect.created')} value={when(token.created_at)} />
      </dl>
      {open && <TokenAudit tokenId={token.token_id} />}
    </li>
  )
}

export function TokenList({ tokens, projectNames }: Readonly<{
  tokens: readonly ConnectToken[]; projectNames: ReadonlyMap<string, string>
}>) {
  const { t } = useTranslation('common')
  const queryClient = useQueryClient()
  const [pending, setPending] = useState<ConnectToken | null>(null)
  const revoke = useMutation({
    mutationFn: (tokenId: string) => connectApi.revokeToken(tokenId),
    onSettled: () => {
      setPending(null)
      void queryClient.invalidateQueries({ queryKey: CONNECT_TOKENS_KEY })
    },
  })

  return (
    <section className="card space-y-2" aria-labelledby="connect-tokens-title">
      <h2 id="connect-tokens-title" className="text-base font-semibold text-text-strong">{t('connect.tokensTitle')}</h2>
      {tokens.length === 0
        ? <p className="text-sm text-muted">{t('connect.tokensEmpty')}</p>
        : (
          <ul className="divide-y divide-border">
            {tokens.map((token) => (
              <TokenRow key={token.token_id} token={token}
                projectName={token.project_id ? projectNames.get(token.project_id) : undefined} onRevoke={setPending} />
            ))}
          </ul>
        )}
      {revoke.isError && <p role="alert" className="text-sm text-danger">{t('connect.revokeFailed')}</p>}
      <ConfirmModal
        isOpen={pending !== null}
        title={t('connect.revokeTitle')}
        message={t('connect.revokeBody', { name: pending?.name ?? '' })}
        confirmLabel={t('connect.revoke')}
        variant="danger"
        isLoading={revoke.isPending}
        onConfirm={() => { if (pending) revoke.mutate(pending.token_id) }}
        onCancel={() => setPending(null)}
      />
    </section>
  )
}
