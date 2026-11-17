/**
 * @fileoverview Registry → **Create from a skill** (`POST /agents/engineering/registry/cards`), a form on the app's
 * side sheet: a role and one of its ACCEPTED skill versions in a scope (the shared skills or a connection's), a slug
 * (the card's id is `<role>-<slug>`), an optional title, a purpose, and caps at most the template's. The card's
 * model, tools and harness are its skill version's: a card says what runs, never chooses it. Checked here first, by
 * field (createCardRules.ts), then by the server, whose refusal (a proposal, a slug taken, a bad model or tool) is said
 * in its words. Made, its page opens.
 *
 * @module pages/Agents/Registry/CreateCardSheet
 */
import { useId, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { Loader2 } from 'lucide-react'
import LoadFailed from '../../../components/LoadFailed/LoadFailed'
import SideSheet from '../../../components/SideSheet/SideSheet'
import { engineeringRegistryApi, engineeringRegistryKeys } from '../../../api/engineeringRegistryApi'
import { engineeringSkillsApi, engineeringSkillsKeys, isSkillRole } from '../../../api/engineeringSkillsApi'
import { serverReason } from '../../../lib/errors'
import { useConfigStore } from '../../../store/configStore'
import { ScopePicker } from '../ScopePicker'
import { CARD_LIMITS, cardIdOf, cardIssues, createCardBody } from './createCardRules'
import { useCardTitle } from './cardTitle'
import type { ReactNode } from 'react'
import type { CardField, CardForm, FieldIssue } from './createCardRules'
import type { RegistryCard } from '../../../api/engineeringRegistryApi'

interface SheetProps {
  /** The roles' cards (the launchable ones are offered), as the Registry read them. */
  readonly roles: readonly RegistryCard[]
  /** The role to start from ('' or one not offered: the first offered). */
  readonly role: string
  readonly connection: string
  readonly onClose: () => void
  readonly onCreated: (card: RegistryCard) => void
}

/** A labelled field with its issue said under it (and named by it). */
function Field({ label, hint, issue, children }: Readonly<{
  label: string; hint?: string; issue: string | null; children: (id: string, describedBy: string | undefined) => ReactNode
}>) {
  const id = useId()
  const describedBy = [hint === undefined ? null : `${id}-hint`, issue === null ? null : `${id}-issue`].filter((part) => part !== null).join(' ')
  return (
    <div className="space-y-1">
      <label htmlFor={id} className="block text-[12px] font-semibold text-muted">{label}</label>
      {children(id, describedBy === '' ? undefined : describedBy)}
      {hint !== undefined && <p id={`${id}-hint`} className="text-[12px] text-muted">{hint}</p>}
      {issue !== null && <p id={`${id}-issue`} className="text-[12px] text-danger">{issue}</p>}
    </div>
  )
}

/** The accepted versions of a role in a scope (a proposal never makes a card), newest first. */
function useAcceptedVersions(connection: string, role: string) {
  const configured = useConfigStore((s) => s.config.apiEndpoint) !== ''
  const skillRole = isSkillRole(role) ? role : null
  return useQuery({
    queryKey: engineeringSkillsKeys.accepted(connection, role),
    queryFn: async () => {
      if (skillRole === null) return []
      const page = await engineeringSkillsApi.history(connection, skillRole, '')
      return page.versions.filter((line) => line.status === 'accepted')
    },
    enabled: configured && skillRole !== null,
  })
}

function VersionField({ form, onChange, issue }: Readonly<{ form: CardForm; onChange: (version: number | null) => void; issue: string | null }>) {
  const { t } = useTranslation('agents')
  const versions = useAcceptedVersions(form.connection, form.role)
  if (versions.isError) {
    return <LoadFailed message={t('registry.create.versionsFailed')} onRetry={() => void versions.refetch()} retrying={versions.isFetching} />
  }
  const accepted = versions.data ?? []
  return (
    <Field label={t('registry.create.version')} issue={issue}
      hint={versions.isSuccess && accepted.length === 0 ? t('registry.create.versionNone') : undefined}>
      {(id, describedBy) => (
        <select id={id} className="select w-full" value={form.version ?? ''} aria-describedby={describedBy}
          aria-invalid={issue === null ? undefined : true}
          onChange={(event) => onChange(event.target.value === '' ? null : Number(event.target.value))}>
          <option value="">{t('registry.create.versionPick')}</option>
          {accepted.map((line) => (
            <option key={line.version} value={line.version}>{t('registry.create.versionLabel', { version: line.version, summary: line.summary })}</option>
          ))}
        </select>
      )}
    </Field>
  )
}

function CapsFields({ form, caps, onChange, issueOf }: Readonly<{
  form: CardForm; caps: Readonly<Record<string, number>>; onChange: (name: string, value: string) => void
  issueOf: (field: CardField) => string | null
}>) {
  const { t } = useTranslation('agents')
  const names = Object.keys(caps)
  if (names.length === 0) return null
  return (
    <fieldset className="space-y-2">
      <legend className="text-sm font-semibold text-text-strong">{t('registry.create.caps')}</legend>
      <p className="text-[12px] text-muted">{t('registry.create.capsHint')}</p>
      {names.map((name) => (
        <Field key={name} label={t('registry.create.cap', { name, max: caps[name] ?? 0 })} issue={issueOf(`cap:${name}`)}>
          {(id, describedBy) => (
            <input id={id} className="input w-full" inputMode="numeric" value={form.caps[name] ?? ''} aria-describedby={describedBy}
              aria-invalid={issueOf(`cap:${name}`) === null ? undefined : true} onChange={(event) => onChange(name, event.target.value)} />
          )}
        </Field>
      ))}
    </fieldset>
  )
}

export function CreateCardSheet({ roles, role, connection, onClose, onCreated }: SheetProps) {
  const { t } = useTranslation('agents')
  const title = useCardTitle()
  const queryClient = useQueryClient()
  const launchable = roles.filter((card) => card.kind === 'role' && card.launchable)
  const [form, setForm] = useState<CardForm>(() => ({
    role: launchable.some((card) => card.id === role) ? role : launchable[0]?.id ?? '', connection, version: null, slug: '',
    title: '', purpose: '', caps: {},
  }))
  const [issues, setIssues] = useState<readonly FieldIssue[]>([])
  const template = launchable.find((card) => card.id === form.role)
  const templateCaps = template?.caps ?? {}
  const create = useMutation({
    mutationFn: () => engineeringRegistryApi.create(createCardBody(form)),
    onSuccess: async (card) => {
      await queryClient.invalidateQueries({ queryKey: engineeringRegistryKeys.all() })
      onCreated(card)
    },
  })
  const set = (next: Partial<CardForm>) => setForm((was) => ({ ...was, ...next }))
  const issueOf = (field: CardField) => {
    const found = issues.find((entry) => entry.field === field)
    return found === undefined ? null : t(`registry.create.issues.${found.issue}`, { max: CARD_LIMITS.maxPurpose })
  }
  const submit = () => {
    const found = cardIssues(form, launchable.map((card) => card.id), templateCaps)
    setIssues(found)
    if (found.length === 0 && !create.isPending) create.mutate()
  }
  const footer = (
    <>
      <button type="button" className="btn btn-secondary btn-sm" onClick={onClose}>{t('registry.create.cancel')}</button>
      <button type="button" className="btn btn-primary btn-sm" aria-disabled={create.isPending} onClick={submit}>
        {create.isPending && <Loader2 size={14} className="animate-spin" aria-hidden="true" />}{t('registry.create.submit')}
      </button>
    </>
  )
  return (
    <SideSheet isOpen onClose={onClose} title={t('registry.create.title')} description={t('registry.create.description')} footer={footer}>
      <Field label={t('registry.create.role')} issue={issueOf('role')}>
        {(id, describedBy) => (
          <select id={id} className="select w-full" value={form.role} aria-describedby={describedBy}
            onChange={(event) => set({ role: event.target.value, version: null, caps: {} })}>
            {launchable.map((card) => <option key={card.id} value={card.id}>{title(card)}</option>)}
          </select>
        )}
      </Field>
      <ScopePicker connection={form.connection} label={t('registry.create.scope')} sharedLabel={t('skills.shared')}
        onChange={(next) => set({ connection: next, version: null })} />
      <VersionField form={form} onChange={(version) => set({ version })} issue={issueOf('version')} />
      <Field label={t('registry.create.slug')} issue={issueOf('slug')}
        hint={t('registry.create.slugHint', { id: cardIdOf(form.role, form.slug === '' ? 'slug' : form.slug) })}>
        {(id, describedBy) => (
          <input id={id} className="input w-full font-mono" maxLength={CARD_LIMITS.maxSlug} value={form.slug} aria-describedby={describedBy}
            aria-invalid={issueOf('slug') === null ? undefined : true} onChange={(event) => set({ slug: event.target.value })} />
        )}
      </Field>
      <Field label={t('registry.create.cardTitle')} issue={issueOf('title')}>
        {(id, describedBy) => (
          <input id={id} className="input w-full" maxLength={CARD_LIMITS.maxTitle} value={form.title} aria-describedby={describedBy}
            onChange={(event) => set({ title: event.target.value })} />
        )}
      </Field>
      <Field label={t('registry.create.purpose')} issue={issueOf('purpose')}>
        {(id, describedBy) => (
          <input id={id} className="input w-full" maxLength={CARD_LIMITS.maxPurpose} value={form.purpose} aria-describedby={describedBy}
            aria-invalid={issueOf('purpose') === null ? undefined : true} onChange={(event) => set({ purpose: event.target.value })} />
        )}
      </Field>
      <CapsFields form={form} caps={templateCaps} issueOf={issueOf}
        onChange={(name, value) => set({ caps: { ...form.caps, [name]: value } })} />
      {create.isError && (
        <p role="alert" className="text-sm text-danger">
          {serverReason(create.error) === null ? t('registry.create.failed') : t('registry.create.refused', { message: serverReason(create.error) })}
        </p>
      )}
    </SideSheet>
  )
}
