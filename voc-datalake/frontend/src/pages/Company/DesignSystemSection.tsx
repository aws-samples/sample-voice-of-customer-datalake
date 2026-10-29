/**
 * @fileoverview Company → Design system: tokens, components, guidelines, logo,
 * references and integration tokens.
 *
 * The prototype and PR/FAQ generators (and the autonomous agents) build with
 * this, so a prototype matches the company's look. Everyone may view it; admins
 * edit (every write is admin-gated server-side). "Use as design system" on a
 * reference loads a merged draft here with a change banner, "Use this logo" puts the
 * reference's logo into the same draft; only Save stores either.
 *
 * @module pages/Company/DesignSystemSection
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router-dom'
import { Palette } from 'lucide-react'
import { designSystemApi, designSystemBody, designSystemKey } from '../../api/designSystemApi'
import type { DesignSystem, DesignSystemBody } from '../../api/designSystemApi'
import { componentsInvalid } from '../../api/designComponents'
import ApplyBanner from './ApplyBanner'
import DesignComponentsEditor from './DesignComponentsEditor'
import DesignTokensEditor from './DesignTokensEditor'
import { useApplyReference } from './useApplyReference'
import { ReferencesPanel } from './DesignReferences'
import { LogoUpload } from './LogoUpload'
import { GroupLabel, MarkdownField, MarkdownView, SectionHeader, ViewOnlyBadge } from './ContextParts'
import { DraftSaveRow, LoadedSection } from './SectionParts'
import { useDraft, useDraftGuard } from './useDraft'

const MAX_GUIDELINES_CHARS = 20_000
const READING_POLL_MS = 5_000

const EMPTY: DesignSystemBody = { tokens: { colors: [], typography: [], spacing: [], radius: [] }, guidelines: '', components: [] }

function editable(data: DesignSystem | undefined): DesignSystemBody | undefined {
  return data ? { tokens: data.tokens, guidelines: data.guidelines, components: data.components } : undefined
}

export default function DesignSystemSection({ isAdmin }: Readonly<{ isAdmin: boolean }>) {
  const { t } = useTranslation('settings')
  const queryClient = useQueryClient()
  // While a reference is being read, poll so its preview appears without a reload.
  const query = useQuery({
    queryKey: designSystemKey(),
    queryFn: designSystemApi.get,
    refetchInterval: (current) => (current.state.data?.references.some((r) => r.status === 'pending') ? READING_POLL_MS : false),
  })
  // Dirty compares what Save would send, so an empty hover/focus or a trailing space is not a change.
  const draft = useDraft<DesignSystemBody>(editable(query.data) ?? EMPTY, designSystemBody)
  const data = query.data
  const invalid = draft.value.guidelines.length > MAX_GUIDELINES_CHARS || componentsInvalid(draft.value.components)
  const applying = useApplyReference({
    saved: editable(data),
    dirty: draft.dirty,
    // A logo already put into the draft ("Use this logo") stays when a reference's design is loaded.
    load: (value) => draft.update((current) => ({ ...value, logo: current.logo })),
  })
  // THE one Discard: the banner's "Discard", the save row's "Discard changes" and the unsaved-changes
  // guard all drop the whole draft (tokens, components, guidelines AND a drafted logo) and the banner.
  const discard = () => {
    draft.reset()
    applying.clear()
  }
  const save = useMutation({
    mutationFn: designSystemApi.save,
    onSuccess: (saved) => {
      queryClient.setQueryData(designSystemKey(), saved)
      discard()
    },
  })
  const guard = useDraftGuard({
    dirty: isAdmin && draft.dirty,
    reset: discard,
    save: () => save.mutateAsync(draft.value),
    canSave: !invalid,
  })

  return (
    <div className="space-y-4 sm:space-y-6">
      <div className="card">
        <SectionHeader
          icon={Palette}
          title={t('designSystem.title')}
          description={t('designSystem.description')}
          aside={isAdmin ? null : <ViewOnlyBadge />}
        />
        <LoadedSection query={query}>
          {(loaded) => (
            <div className="space-y-6">
              {isAdmin && applying.applied ? (
                <ApplyBanner
                  applied={applying.applied}
                  saving={save.isPending}
                  saveFailed={save.isError}
                  onSave={() => save.mutate(draft.value)}
                  onDiscard={discard}
                />
              ) : null}
              <LogoUpload logoUrl={loaded.logo_url} draftLogo={draft.value.logo} canEdit={isAdmin} />
              <DesignTokensEditor
                tokens={draft.value.tokens}
                readOnly={!isAdmin}
                onChange={(change) => draft.update((d) => ({ ...d, tokens: change(d.tokens) }))}
              />
              <DesignComponentsEditor
                components={draft.value.components}
                colors={draft.value.tokens.colors}
                readOnly={!isAdmin}
                onChange={(change) => draft.update((d) => ({ ...d, components: change(d.components) }))}
              />
              {isAdmin ? (
                <MarkdownField
                  label={t('designSystem.guidelines')}
                  value={draft.value.guidelines}
                  onChange={(guidelines) => draft.update((d) => ({ ...d, guidelines }))}
                  maxChars={MAX_GUIDELINES_CHARS}
                  placeholder={t('designSystem.guidelinesPlaceholder')}
                />
              ) : (
                <div>
                  <GroupLabel>{t('designSystem.guidelines')}</GroupLabel>
                  <MarkdownView source={loaded.guidelines} empty={t('designSystem.noGuidelines')} />
                </div>
              )}
              {isAdmin ? (
                <DraftSaveRow
                  save={save}
                  dirty={draft.dirty}
                  onSave={() => save.mutate(draft.value)}
                  onDiscard={discard}
                  invalid={invalid}
                />
              ) : null}
            </div>
          )}
        </LoadedSection>
      </div>
      {data ? (
        <div className="card space-y-6">
          <ReferencesPanel
            references={data.references}
            canEdit={isAdmin}
            apply={applying.controls}
            onLogoDrafted={(logo) => draft.update((d) => ({ ...d, logo }))}
          />
          {isAdmin ? (
            <p className="text-xs text-muted">
              {t('designSystem.integrationsMoved')}{' '}
              <Link to="/admin?tab=sources&section=integrations" className="link">{t('designSystem.integrationsLink')}</Link>
            </p>
          ) : null}
        </div>
      ) : null}
      {guard.dialog}
      {applying.dialog}
    </div>
  )
}
