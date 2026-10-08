/**
 * @fileoverview Company → Design system: tokens, guidelines, logo, references
 * and integration tokens.
 *
 * The prototype and PR/FAQ generators (and the autonomous agents) build with
 * this, so a prototype matches the company's look. Everyone may view it; admins
 * edit (every write is admin-gated server-side).
 *
 * @module pages/Company/DesignSystemSection
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router-dom'
import { Palette } from 'lucide-react'
import { designSystemApi, designSystemKey } from '../../api/designSystemApi'
import type { DesignTokens } from '../../api/designSystemApi'
import DesignTokensEditor from './DesignTokensEditor'
import { LogoUpload, ReferencesPanel } from './DesignReferences'
import { GroupLabel, MarkdownField, MarkdownView, SectionHeader, ViewOnlyBadge } from './ContextParts'
import { DraftSaveRow, LoadedSection } from './SectionParts'
import { useDraft, useDraftGuard } from './useDraft'

const MAX_GUIDELINES_CHARS = 20_000

interface EditableDesign {
  tokens: DesignTokens
  guidelines: string
}

const EMPTY: EditableDesign = { tokens: { colors: [], typography: [], spacing: [], radius: [] }, guidelines: '' }

export default function DesignSystemSection({ isAdmin }: Readonly<{ isAdmin: boolean }>) {
  const { t } = useTranslation('settings')
  const queryClient = useQueryClient()
  const query = useQuery({ queryKey: designSystemKey(), queryFn: designSystemApi.get })
  const draft = useDraft<EditableDesign>(query.data ? { tokens: query.data.tokens, guidelines: query.data.guidelines } : EMPTY)
  const save = useMutation({
    mutationFn: designSystemApi.save,
    onSuccess: (saved) => {
      queryClient.setQueryData(designSystemKey(), saved)
      draft.reset()
    },
  })
  const data = query.data
  const guard = useDraftGuard({
    dirty: isAdmin && draft.dirty,
    reset: draft.reset,
    save: () => save.mutateAsync(draft.value),
    canSave: draft.value.guidelines.length <= MAX_GUIDELINES_CHARS,
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
              <LogoUpload logoUrl={loaded.logo_url} canEdit={isAdmin} />
              <DesignTokensEditor
                tokens={draft.value.tokens}
                readOnly={!isAdmin}
                onChange={(change) => draft.update((d) => ({ ...d, tokens: change(d.tokens) }))}
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
                  invalid={draft.value.guidelines.length > MAX_GUIDELINES_CHARS}
                />
              ) : null}
            </div>
          )}
        </LoadedSection>
      </div>
      {data ? (
        <div className="card space-y-6">
          <ReferencesPanel references={data.references} canEdit={isAdmin} />
          {isAdmin ? (
            <p className="text-xs text-muted">
              {t('designSystem.integrationsMoved')}{' '}
              <Link to="/admin?tab=integrations" className="link">{t('designSystem.integrationsLink')}</Link>
            </p>
          ) : null}
        </div>
      ) : null}
      {guard.dialog}
    </div>
  )
}
