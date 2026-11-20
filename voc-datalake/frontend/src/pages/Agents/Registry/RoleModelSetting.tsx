/**
 * @fileoverview Registry → a role's card → **Model** (7.58.00, `PUT /agents/engineering/registry/<role>/model`): the
 * model the role runs on in this deployment, one choice for both harnesses (ModelChoiceField.tsx: the role's default,
 * Auto, Opus, Sonnet or Haiku 5.5, or another model id), what it means on the harness this deployment runs the role on
 * (`runs_on`), who last changed it and when, and Save. An other id is checked here first (its shape; on the native
 * harness, one of the models this deployment grants and prices), then by the server, whose refusal is said in its
 * words. A run's start records the choices, so a change applies from the next run. A card made from a skill runs its
 * role's choice: said here, read only.
 *
 * @module pages/Agents/Registry/RoleModelSetting
 */
import { useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { Loader2 } from 'lucide-react'
import { engineeringRegistryApi, engineeringRegistryKeys } from '../../../api/engineeringRegistryApi'
import StickyActionBar from '../../../components/StickyActionBar/StickyActionBar'
import { modelShortName } from '../../../components/WorkflowEditor/nodes/nodeText'
import { serverReason } from '../../../lib/errors'
import { ModelChoiceField } from '../ModelChoiceField'
import { modelChoiceOf, draftOf, modelIssue, modelOn } from '../modelChoice'
import { useModelChoiceText } from '../modelChoiceText'
import { useSkillFormats } from '../skillFormats'
import type { RegistryCard } from '../../../api/engineeringRegistryApi'

/** What the choice runs on the harness the role is on here, in a sentence (on Kiro, the role's default by Kiro's name
 * for it: a model Kiro cannot use stops the step for a person). */
function useRunsOn(card: RegistryCard, choice: string | null): string {
  const { t } = useTranslation('agents')
  const text = useModelChoiceText()
  const model = modelOn(choice, card.runs_on, card.model)
  if (card.runs_on === 'native') return t('registry.model.runsNative', { model: text.model(model), id: model })
  return model === 'auto' ? t('registry.model.runsKiroAuto') : t('registry.model.runsKiro', { model: text.model(model), id: model })
}

function Changed({ card }: Readonly<{ card: RegistryCard }>) {
  const { t } = useTranslation('agents')
  const format = useSkillFormats()
  const text = useModelChoiceText()
  const { model_choice_updated_by: by, model_choice_updated_at: at, template_model_choice: template } = card
  return (
    <>
      {by !== null && at !== null && <p className="text-[12px] text-muted">{t('registry.model.changed', { who: by, at: format.at(at) })}</p>}
      {template !== null && <p className="text-[12px] text-muted">{t('registry.model.template', { model: text.choice(template) })}</p>}
    </>
  )
}

function RoleModelForm({ card, enabled }: Readonly<{ card: RegistryCard; enabled: readonly string[] }>) {
  const { t } = useTranslation('agents')
  const queryClient = useQueryClient()
  const [draft, setDraft] = useState(() => draftOf(card.model_choice))
  const choice = modelChoiceOf(draft)
  const issue = modelIssue(draft, card.runs_on === 'native' ? enabled : null)
  const runsOn = useRunsOn(card, choice)
  const save = useMutation({
    mutationFn: () => engineeringRegistryApi.setModel(card.base_role, choice),
    onSuccess: async () => { await queryClient.invalidateQueries({ queryKey: engineeringRegistryKeys.all() }) },
  })
  const unchanged = choice === card.model_choice
  const blocked = issue !== null || unchanged || save.isPending
  const reason = save.isError ? serverReason(save.error) : null
  return (
    <section aria-labelledby="role-model" className="card space-y-3">
      <h3 id="role-model" className="text-sm font-semibold text-text-strong">{t('registry.model.title')}</h3>
      <ModelChoiceField label={t('registry.model.label')} defaultLabel={t('registry.model.default', { model: modelShortName(card.model) })}
        draft={draft} onChange={(next) => { setDraft(next); save.reset() }} harness={card.runs_on} enabled={enabled}
        disabled={save.isPending} />
      <p className="text-[12px] text-text">{runsOn}</p>
      {card.runs_on === 'kiro' && <p className="text-[12px] text-muted">{t('registry.model.kiroStops')}</p>}
      <p className="text-[12px] text-muted">{t('registry.model.nextRun')}</p>
      <Changed card={card} />
      <StickyActionBar variant="inline" className="flex flex-wrap items-center gap-2 py-2">
        <button type="button" className="btn btn-primary btn-sm" aria-disabled={blocked} disabled={blocked} onClick={() => save.mutate()}>
          {save.isPending && <Loader2 size={14} className="animate-spin" aria-hidden="true" />}{t('registry.model.save')}
        </button>
        {save.isSuccess && <span role="status" className="text-[12px] text-ok">{t('registry.model.saved')}</span>}
      </StickyActionBar>
      {save.isError && (
        <p role="alert" className="text-sm text-danger">
          {reason === null ? t('registry.model.failed') : t('registry.model.refused', { message: reason })}
        </p>
      )}
    </section>
  )
}

/** A role's card: the form; a made card: its role's choice, read only; a card never launched (Learn's): nothing. */
export function RoleModelSetting({ card, enabled }: Readonly<{ card: RegistryCard; enabled: readonly string[] }>) {
  const { t } = useTranslation('agents')
  const text = useModelChoiceText()
  if (card.kind === 'role' && card.launchable) {
    return <RoleModelForm key={`${card.base_role}:${card.model_choice ?? ''}`} card={card} enabled={enabled} />
  }
  if (card.kind !== 'card') return null
  const choice = card.model_choice === null ? t('registry.model.roleDefault') : text.choice(card.model_choice)
  return <p className="text-[12px] text-muted">{t('registry.model.madeCard', { model: choice })}</p>
}
