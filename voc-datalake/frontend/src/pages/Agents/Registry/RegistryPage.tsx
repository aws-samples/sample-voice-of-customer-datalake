/**
 * @fileoverview Agents → **Registry** (7.52.00; part 4 §4.3; administrators, while the engineering agents are on): the
 * building blocks a flow is made of, read only, behind one segmented filter, **Agents | Quality gates**:
 *
 * - Agents (`/agents/registry`): every role's card and the cards made from a skill (RegistryCards.tsx), for a scope
 *   (`?connection=`: the shared skills, or one connection's head); a card opens its page (`/agents/registry/<card>`,
 *   AgentCardDetail.tsx). **Create from a skill** makes one (CreateCardSheet.tsx, on the side sheet).
 * - Quality gates (`/agents/registry/gates`): the gate packs with their steps, tools and briefs (QualityGates.tsx); a
 *   brief opens on a page of its own (`/agents/registry/gates/briefs/<id>`, GateBrief.tsx).
 *
 * The place is the path (registryPaths.ts); anything else under `/agents/registry` is replaced by the place it names,
 * in place. The view's content only: its tab row and header are the Agents section's.
 *
 * @module pages/Agents/Registry/RegistryPage
 */
import { useState } from 'react'
import { useLocation } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { Plus } from 'lucide-react'
import LoadFailed from '../../../components/LoadFailed/LoadFailed'
import PressedChoices from '../../../components/PressedChoices/PressedChoices'
import { isEngineeringAvailable } from '../../../runtimeConfig'
import { useIsAdmin } from '../../../store/authStore'
import { usePlaceNavigate, useReplaceAddress } from '../../../utils/pathPlace'
import { ScopePicker } from '../ScopePicker'
import { AgentCardDetail } from './AgentCardDetail'
import { CreateCardSheet } from './CreateCardSheet'
import { GateBriefPage } from './GateBrief'
import { QualityGates } from './QualityGates'
import { RegistryCards } from './RegistryCards'
import { useRegistryList } from './useRegistryList'
import { REGISTRY_FILTERS, filterOf, readRegistryAddress, registryCardPath, registryPath } from './registryPaths'
import type { RegistryFilter, RegistryPlace } from './registryPaths'

function CardsView({ connection, search, onCreate }: Readonly<{ connection: string; search: string; onCreate: () => void }>) {
  const { t } = useTranslation('agents')
  const read = useRegistryList(connection)
  if (read.isLoading) return <div className="skeleton h-32" role="status" aria-label={t('registry.loading')} />
  if (read.isError || read.data === undefined) {
    return <LoadFailed message={t('registry.failed')} onRetry={() => void read.refetch()} retrying={read.isFetching} />
  }
  return <RegistryCards cards={read.data} search={search} onCreate={onCreate} />
}

/** The place's body: the cards, one card, the quality gates or one brief. */
function PlaceBody({ place, connection, search, onCreate }: Readonly<{
  place: RegistryPlace; connection: string; search: string; onCreate: (role: string) => void
}>) {
  switch (place.view) {
    case 'card': return <AgentCardDetail cardId={place.card} connection={connection} search={search} onCreate={onCreate} />
    case 'gates': return <QualityGates connection={connection} />
    case 'brief': return <GateBriefPage briefId={place.brief} search={search} />
    default: return <CardsView connection={connection} search={search} onCreate={() => onCreate('')} />
  }
}

function Registry({ place }: Readonly<{ place: RegistryPlace }>) {
  const { t } = useTranslation('agents')
  const location = useLocation()
  const move = usePlaceNavigate()
  const connection = new URLSearchParams(location.search).get('connection') ?? ''
  const cards = useRegistryList(connection)
  const [creating, setCreating] = useState<string | null>(null)
  const filter = filterOf(place)
  const withScope = (next: string) => {
    const params = new URLSearchParams(location.search)
    if (next === '') params.delete('connection')
    else params.set('connection', next)
    const query = params.toString()
    return query === '' ? '' : `?${query}`
  }
  const choose = (next: RegistryFilter) => move({ pathname: registryPath({ view: next }), search: location.search })
  return (
    <section className="space-y-4">
      <p className="max-w-prose text-sm text-muted">{t('registry.hint')}</p>
      <div className="flex flex-wrap items-end gap-3">
        <PressedChoices label={t('registry.filters.label')} choices={REGISTRY_FILTERS} value={filter} onChange={choose}
          display={(choice) => t(`registry.filters.${choice}`)} className="tabs-track w-fit" pressedClassName="tab tab-active"
          idleClassName="tab" />
        <ScopePicker connection={connection} label={t('registry.scope')} sharedLabel={t('skills.shared')}
          onChange={(next) => move({ pathname: location.pathname, search: withScope(next) })} />
        {filter === 'cards' && (
          <button type="button" className="btn btn-primary btn-sm ms-auto" aria-disabled={cards.data === undefined}
            onClick={() => { if (cards.data !== undefined) setCreating('') }}>
            <Plus size={14} aria-hidden="true" />{t('registry.create.button')}
          </button>
        )}
      </div>
      <PlaceBody place={place} connection={connection} search={location.search}
        onCreate={(role) => { if (cards.data !== undefined) setCreating(role) }} />
      {creating !== null && cards.data !== undefined && (
        <CreateCardSheet roles={cards.data} role={creating} connection={connection} onClose={() => setCreating(null)}
          onCreated={(card) => {
            setCreating(null)
            move({ pathname: registryCardPath(card.id), search: location.search })
          }} />
      )}
    </section>
  )
}

export default function RegistryPage() {
  const { t } = useTranslation('agents')
  const isAdmin = useIsAdmin()
  const read = readRegistryAddress(useLocation())
  useReplaceAddress(read?.replaceWith ?? null)
  if (!isAdmin || !isEngineeringAvailable()) {
    return <p className="card p-6 text-center text-sm text-muted">{t('registry.notAvailable')}</p>
  }
  return <Registry place={read?.place ?? { view: 'cards' }} />
}
