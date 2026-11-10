/**
 * @fileoverview "My sign-ins": the assistants signed in to the MCP server with my account (MCP OAuth,
 * docs/mcp.md), one per client, with revoke. A revoke refuses the client's next request at once; the
 * assistant has to sign in and approve again.
 *
 * @module pages/Connect/GrantList
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ShieldOff } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { OAUTH_GRANTS_KEY, oauthApi } from '../../api/oauthApi'
import type { OAuthGrant } from '../../api/oauthSchema'
import ConfirmModal from '../../components/ConfirmModal/ConfirmModal'
import { formatDateTime } from '../../utils/dateUtils'

function GrantRow({ grant, onRevoke }: Readonly<{ grant: OAuthGrant; onRevoke: (grant: OAuthGrant) => void }>) {
  const { t, i18n } = useTranslation('common')
  return (
    <li className="flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-border py-2 first:border-t-0 text-sm"
      data-testid={`connect-grant-${grant.grant_id}`}>
      <span className="font-medium text-text-strong">{grant.client_name || grant.client_kind}</span>
      <span className="badge">{t(`connect.scope.${grant.scope}`)}</span>
      <span className={grant.status === 'active' ? 'badge badge-ok' : 'badge badge-danger'}>
        {t(`connect.oauth.status.${grant.status}`)}
      </span>
      {grant.project_id && <span className="text-[12px] text-muted">{grant.project_id}</span>}
      <span className="text-[12px] text-muted">
        {t('connect.lastUsed')}: {formatDateTime(grant.last_used_at, i18n.language, t('connect.never'))}
      </span>
      {grant.status === 'active' && (
        <button type="button" className="btn btn-secondary btn-sm ml-auto" onClick={() => onRevoke(grant)}
          aria-label={t('connect.oauth.revokeNamed', { name: grant.client_name })}>
          <ShieldOff size={14} aria-hidden="true" /> {t('connect.revoke')}
        </button>
      )}
    </li>
  )
}

export function GrantList() {
  const { t } = useTranslation('common')
  const queryClient = useQueryClient()
  const [pending, setPending] = useState<OAuthGrant | null>(null)
  const grants = useQuery({ queryKey: OAUTH_GRANTS_KEY, queryFn: () => oauthApi.listGrants() })
  const revoke = useMutation({
    mutationFn: (grantId: string) => oauthApi.revokeGrant(grantId),
    onSettled: () => {
      setPending(null)
      void queryClient.invalidateQueries({ queryKey: OAUTH_GRANTS_KEY })
    },
  })

  return (
    <section className="card space-y-2" aria-labelledby="connect-grants-title">
      <h2 id="connect-grants-title" className="text-base font-semibold text-text-strong">{t('connect.oauth.grantsTitle')}</h2>
      {grants.isError && <p role="alert" className="text-sm text-danger">{t('connect.oauth.grantsFailed')}</p>}
      {revoke.isError && <p role="alert" className="text-sm text-danger">{t('connect.revokeFailed')}</p>}
      {grants.data?.length === 0 && <p className="text-sm text-muted">{t('connect.oauth.grantsEmpty')}</p>}
      {grants.data && grants.data.length > 0 && (
        <ul>{grants.data.map((grant) => <GrantRow key={grant.grant_id} grant={grant} onRevoke={setPending} />)}</ul>
      )}
      <ConfirmModal
        isOpen={pending !== null}
        title={t('connect.oauth.revokeTitle')}
        message={t('connect.oauth.revokeBody', { name: pending?.client_name ?? '' })}
        confirmLabel={t('connect.revoke')}
        variant="danger"
        isLoading={revoke.isPending}
        onConfirm={() => { if (pending) revoke.mutate(pending.grant_id) }}
        onCancel={() => setPending(null)}
      />
    </section>
  )
}
