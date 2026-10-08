/**
 * @fileoverview Settings → Sources: the data-protection policy of each source
 * (PII handling, retention, restricted visibility) and the dimension values and
 * tags every review from it carries; plus the erasure panel.
 *
 * A source with no profile uses the defaults (keep everything, forever, visible
 * to all). Edits stay in a local draft until Save (one PUT of the whole list,
 * validated server-side).
 *
 * @module components/SourcesManager
 */
import { useTranslation } from 'react-i18next'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import DraftSaveBar from '../DraftSaveBar/DraftSaveBar'
import { DraftLoadGate } from '../DraftSaveBar/DraftParts'
import { useDraftEditor } from '../DraftSaveBar/useDraftEditor'
import { MAX_SOURCE_PROFILES, sourceProfilesApi, sourceProfilesKey } from '../../api/sourceProfilesApi'
import { useDimensionsConfig, useSourceProfiles } from '../../hooks/useDimensions'
import { scrapersApi } from '../../api/scrapersApi'
import { getEnabledPlugins } from '../../plugins'
import AddSourceProfile from './AddSourceProfile'
import ErasurePanel from './ErasurePanel'
import SourceProfileEditor from './SourceProfileEditor'
import { draftProblem, knownSourceIds, newProfile, toDraft, toWire } from './sourceDraft'
import type { SourceProfile } from '../../api/sourceProfilesApi'
import type { DraftProfile } from './sourceDraft'

function ProfilesEditor({ stored }: Readonly<{ stored: readonly SourceProfile[] }>) {
  const { t } = useTranslation('components', { keyPrefix: 'sourcesManager' })
  const queryClient = useQueryClient()
  const { data: dimensionsConfig } = useDimensionsConfig()
  const dimensions = dimensionsConfig?.dimensions ?? []
  const { draft, edit, barProps } = useDraftEditor({
    initial: (): DraftProfile[] => toDraft(stored),
    toWire,
    problem: draftProblem,
    save: (sources: SourceProfile[]) => sourceProfilesApi.saveProfiles(sources),
    onSaved: (sources) => queryClient.setQueryData(sourceProfilesKey(), sources),
  })
  // Scraper reviews carry the scraper's name as their source (docs/source-policies.md).
  const { data: scrapersData } = useQuery({ queryKey: ['scrapers'], queryFn: scrapersApi.getScrapers })
  const scraperNames = (scrapersData?.scrapers ?? []).map((s) => s.name)
  const knownIds = knownSourceIds(getEnabledPlugins().map((m) => m.id), scraperNames)
  const update = (id: string, change: Partial<DraftProfile>) =>
    edit(draft.map((d) => (d.profile.id === id ? { ...d, ...change } : d)))

  return (
    <div className="space-y-4">
      {draft.length === 0 && <p className="text-sm text-muted">{t('empty')}</p>}
      {draft.map((d) => (
        <SourceProfileEditor
          key={d.profile.id}
          profile={d.profile}
          keepForever={d.keepForever}
          retentionText={d.retentionText}
          dimensions={dimensions}
          onChange={(profile) => update(d.profile.id, { profile })}
          onRetentionChange={(change) => update(d.profile.id, change)}
          onTagsValidityChange={(tagsValid) => update(d.profile.id, { tagsValid })}
          onRemove={() => edit(draft.filter((x) => x.profile.id !== d.profile.id))}
        />
      ))}
      <AddSourceProfile knownIds={knownIds} draft={draft} disabled={draft.length >= MAX_SOURCE_PROFILES} onAdd={(id) => edit([...draft, newProfile(id)])} />
      <DraftSaveBar {...barProps} />
      <ErasurePanel profiles={stored} />
    </div>
  )
}

export default function SourcesManager() {
  const { t } = useTranslation('components', { keyPrefix: 'sourcesManager' })
  const { data, isLoading, isError, dataUpdatedAt } = useSourceProfiles()
  return (
    <DraftLoadGate isLoading={isLoading} isError={isError} errorText={t('loadError')}>
      {/* Remounted when the stored list changes, so the draft restarts from it. */}
      <ProfilesEditor key={dataUpdatedAt} stored={data ?? []} />
    </DraftLoadGate>
  )
}
