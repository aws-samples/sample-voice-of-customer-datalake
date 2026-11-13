/**
 * @fileoverview Settings → Sources: the data-protection policy of each source
 * (PII handling, retention, restricted visibility) and the dimension values and
 * tags every review from it carries; plus the erasure panels (one person, a whole source).
 *
 * A source with no profile uses the defaults (keep everything, forever, visible
 * to all; inside a workspace its PII is redacted). Edits stay in a local draft until
 * Save (one PUT of the whole list, validated server-side).
 *
 * Whose profiles (workspace/configScope.ts): Administration edits the deployment's (`'deployment'`, no
 * `X-Workspace-Id` from any address), beside the erasure panels, which start the deployment's erasure jobs; a
 * workspace's settings page edits the workspace's own (`'workspace'`), without them.
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
import { useInvalidateFeedbackData } from '../../api/invalidateFeedbackData'
import { getEnabledPlugins } from '../../plugins'
import AddSourceProfile from './AddSourceProfile'
import ErasurePanel from './ErasurePanel'
import SourceErasurePanel from './SourceErasurePanel'
import SourceProfileEditor from './SourceProfileEditor'
import { draftProblem, knownSourceIds, newProfile, toDraft, toWire } from './sourceDraft'
import type { SourceProfile } from '../../api/sourceProfilesApi'
import type { DraftProfile } from './sourceDraft'
import { scrapersKey } from '../../api/queryKeys'
import { scopedKey, useConfigScope } from '../../workspace/configScope'

function ProfilesEditor({ stored, withErasure }: Readonly<{ stored: readonly SourceProfile[]; withErasure: boolean }>) {
  const { t } = useTranslation('components', { keyPrefix: 'sourcesManager' })
  const queryClient = useQueryClient()
  const invalidateFeedbackData = useInvalidateFeedbackData()
  const scope = useConfigScope()
  const { data: dimensionsConfig } = useDimensionsConfig(scope)
  const dimensions = dimensionsConfig?.dimensions ?? []
  const { draft, edit, barProps, onFieldBlur } = useDraftEditor({
    initial: (): DraftProfile[] => toDraft(stored),
    toWire,
    problem: draftProblem,
    save: (sources: SourceProfile[]) => sourceProfilesApi.saveProfiles(sources, scope),
    onSaved: (sources) => {
      queryClient.setQueryData(scopedKey(sourceProfilesKey(), scope), sources)
      invalidateFeedbackData() // a profile change (restricted, PII policy) changes what the feedback reads return
    },
  })
  // Scraper reviews carry the scraper's name as their source (docs/source-policies.md).
  const { data: scrapersData } = useQuery({ queryKey: scrapersKey(), queryFn: scrapersApi.getScrapers })
  const scraperNames = (scrapersData?.scrapers ?? []).map((s) => s.name)
  const knownIds = knownSourceIds(getEnabledPlugins().map((m) => m.id), scraperNames)
  const update = (id: string, change: Partial<DraftProfile>) =>
    edit(draft.map((d) => (d.profile.id === id ? { ...d, ...change } : d)))

  return (
    <div className="space-y-4" onBlur={onFieldBlur}>
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
      {withErasure && (
        <>
          <ErasurePanel profiles={stored} />
          <SourceErasurePanel profiles={stored} />
        </>
      )}
    </div>
  )
}

/**
 * `withErasure` (default on): the erasure panels, which start the deployment's erasure jobs (`POST
 * /settings/erasure`, deployment-wide whatever the address; for its administrators). A workspace's settings page
 * leaves them out: it edits only that workspace's profiles.
 */
export default function SourcesManager({ withErasure = true }: Readonly<{ withErasure?: boolean }>) {
  const { t } = useTranslation('components', { keyPrefix: 'sourcesManager' })
  const { data, isLoading, isError, dataUpdatedAt } = useSourceProfiles(useConfigScope())
  return (
    <DraftLoadGate isLoading={isLoading} isError={isError} errorText={t('loadError')}>
      {/* Remounted when the stored list changes, so the draft restarts from it. */}
      <ProfilesEditor key={dataUpdatedAt} stored={data ?? []} withErasure={withErasure} />
    </DraftLoadGate>
  )
}
