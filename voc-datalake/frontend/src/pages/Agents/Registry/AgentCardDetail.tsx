/**
 * @fileoverview Registry → one card (`GET …/registry/<card>?connection=`, `/agents/registry/<card>`): its facts as a
 * definition list (CardFacts.tsx: its skill version and provenance, a newer template, its model, tools, caps, inputs
 * and outputs, scorecard and spend), a made card's versions and who made each, and its role's source as the
 * repository holds it (CardSource.tsx, gap S: SKILL.md and agent.yaml in the code view, read only). A role's card
 * offers **Create from a skill** on that role, and (7.58.00) the model its role runs on (RoleModelSetting.tsx).
 *
 * @module pages/Agents/Registry/AgentCardDetail
 */
import { Link } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { ArrowLeft, Plus } from 'lucide-react'
import LoadFailed from '../../../components/LoadFailed/LoadFailed'
import { engineeringRegistryApi, engineeringRegistryKeys } from '../../../api/engineeringRegistryApi'
import { apiErrorStatus, retryOnceUnlessNotFound } from '../../../api/apiErrorStatus'
import { useConfigStore } from '../../../store/configStore'
import { useSkillFormats } from '../skillFormats'
import { CardFacts } from './CardFacts'
import { CardSource } from './CardSource'
import { RoleModelSetting } from './RoleModelSetting'
import { useCardTitle } from './cardTitle'
import { REGISTRY_PATH } from './registryPaths'
import type { RegistryCard, RegistryCardDetail } from '../../../api/engineeringRegistryApi'

function CardVersions({ detail }: Readonly<{ detail: RegistryCardDetail }>) {
  const { t } = useTranslation('agents')
  const format = useSkillFormats()
  if (detail.card.kind !== 'card') return null
  return (
    <section aria-labelledby="card-versions" className="space-y-2">
      <h3 id="card-versions" className="text-sm font-semibold text-text-strong">{t('registry.card.versions')}</h3>
      <ol className="space-y-1 text-sm">
        {detail.versions.map((version) => (
          <li key={version.version ?? 0} className="flex flex-wrap gap-2">
            <span className="font-mono">v{version.version ?? 0}</span>
            <span>{version.skill.label}</span>
            <span className="text-muted">{t('registry.card.madeBy', { who: version.created_by, at: format.at(version.created_at) })}</span>
          </li>
        ))}
      </ol>
    </section>
  )
}

export function AgentCardDetail({ cardId, connection, search, onCreate }: Readonly<{
  cardId: string; connection: string; search: string
  /** Create a card from this role's skill (null: not offered here). */
  onCreate: ((role: string) => void) | null
}>) {
  const { t } = useTranslation('agents')
  const configured = useConfigStore((s) => s.config.apiEndpoint) !== ''
  const read = useQuery({
    queryKey: engineeringRegistryKeys.card(cardId, connection),
    queryFn: () => engineeringRegistryApi.card(cardId, connection),
    enabled: configured,
    retry: retryOnceUnlessNotFound,
  })
  const missing = apiErrorStatus(read.error) === 404
  return (
    <section aria-labelledby="registry-card" aria-busy={read.isFetching} className="space-y-4">
      <Link to={{ pathname: REGISTRY_PATH, search }} className="btn btn-ghost btn-sm w-fit">
        <ArrowLeft size={14} aria-hidden="true" /> {t('registry.card.back')}
      </Link>
      <CardHeader cardId={cardId} card={read.data?.card} onCreate={onCreate} />
      {read.isLoading && <div className="skeleton h-32" role="status" aria-label={t('registry.loading')} />}
      {missing && <p className="card p-6 text-center text-sm text-muted">{t('registry.card.missing', { card: cardId })}</p>}
      {read.isError && !missing && (
        <LoadFailed message={t('registry.card.failed')} onRetry={() => void read.refetch()} retrying={read.isFetching} />
      )}
      {read.data !== undefined && (
        <>
          <CardFacts card={read.data.card} />
          <RoleModelSetting card={read.data.card} enabled={read.data.bedrockEnabled} creditPrice={read.data.kiroCreditPrice} />
          <CardVersions detail={read.data} />
          <CardSource role={read.data.card.base_role} skill={read.data.card.launchable} />
        </>
      )}
    </section>
  )
}

/** The card's name (its id until read), its kind, and Create from a skill on a role's card. */
function CardHeader({ cardId, card, onCreate }: Readonly<{
  cardId: string; card: RegistryCard | undefined; onCreate: ((role: string) => void) | null
}>) {
  const { t } = useTranslation('agents')
  const title = useCardTitle()
  const role = card?.kind === 'role' && card.launchable ? card.base_role : null
  return (
    <div className="flex flex-wrap items-center gap-2">
      <h2 id="registry-card" className="mr-auto text-lg font-semibold text-text-strong">{card === undefined ? cardId : title(card)}</h2>
      {card !== undefined && <span className="badge badge-muted">{t(`registry.kind.${card.kind}`)}</span>}
      {role !== null && onCreate !== null && (
        <button type="button" className="btn btn-secondary btn-sm" onClick={() => onCreate(role)}>
          <Plus size={14} aria-hidden="true" />{t('registry.create.button')}
        </button>
      )}
    </div>
  )
}
