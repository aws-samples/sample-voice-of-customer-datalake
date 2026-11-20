/**
 * @fileoverview Agents → Skills, a scope's roles (part 4 §4.4, part 2 S10): **Role · Waiting for review · Current ·
 * Template · Last change**, the roles with a proposal waiting first. A role opens its history; a proposal waiting
 * opens its review. The Template column is the Registry's (`GET …/registry?connection=`: each role's card says
 * whether its template is newer than the scope's versions), in `badge-info` ("Update available (v4)"), with
 * **Review** to the role, where the template is compared and proposed.
 *
 * @module pages/Agents/SkillRolesTable
 */
import { useTranslation } from 'react-i18next'
import { useRegistryList } from './Registry/useRegistryList'
import { SkillStatusBadge } from './SkillHistory'
import { TemplateBadge } from './SkillTemplateUpdate'
import { useSkillFormats } from './skillFormats'
import { rolesInOrder } from './skillsView'
import type { RegistryCard } from '../../api/engineeringRegistryApi'
import type { SkillRole, SkillRoleLine } from '../../api/engineeringSkillsApi'

/** Each role's card in a scope (its template and whether it is newer), from the Registry (none while unread). */
function useRoleCards(connection: string): { readonly failed: boolean; readonly cards: ReadonlyMap<string, RegistryCard> } {
  const read = useRegistryList(connection)
  const roles = (read.data ?? []).filter((card) => card.kind === 'role')
  return { failed: read.isError, cards: new Map(roles.map((card) => [card.id, card])) }
}

function TemplateCell({ failed, card, onReview }: Readonly<{ failed: boolean; card: RegistryCard | undefined; onReview: () => void }>) {
  const { t } = useTranslation('agents')
  if (failed) return <span className="text-[12px] text-muted">{t('skills.templateUnknown')}</span>
  const template = card?.skill.template_newer === true ? card.template : null
  if (template === null) return <span className="text-muted">—</span>
  return (
    <span className="flex flex-wrap items-center gap-2">
      <TemplateBadge template={{ version: template.version, label: template.label, newer: true }} />
      <button type="button" className="btn btn-ghost btn-sm" onClick={onReview}>{t('skills.review')}</button>
    </span>
  )
}

function WaitingCell({ line, onReview }: Readonly<{ line: SkillRoleLine; onReview: (version: number) => void }>) {
  const { t } = useTranslation('agents')
  const latest = line.latest
  if (latest?.status !== 'proposed') return <span className="text-muted">—</span>
  return (
    <span className="flex flex-wrap items-center gap-2">
      <span className="badge badge-warn">{t('skills.toReview', { version: latest.version })}</span>
      <button type="button" className="btn btn-ghost btn-sm" onClick={() => onReview(latest.version)}
        aria-label={t('skills.reviewVersion', { role: t(`skills.role.${line.role}`), version: latest.version })}>
        {t('skills.review')}
      </button>
    </span>
  )
}

export function SkillRolesTable({ connection, roles, onOpen, onReview }: Readonly<{
  connection: string; roles: SkillRoleLine[]; onOpen: (role: SkillRole) => void; onReview: (role: SkillRole, version: number) => void
}>) {
  const { t } = useTranslation('agents')
  const format = useSkillFormats()
  const { failed, cards } = useRoleCards(connection)
  const th = 'px-3 py-2 text-left text-[12px] font-semibold text-muted'
  return (
    <div className="overflow-x-auto rounded-lg border border-border">
      <table className="w-full min-w-[44rem]">
        <caption className="sr-only">{t('skills.rolesCaption')}</caption>
        <thead className="bg-bg-accent border-b border-border">
          <tr>
            <th scope="col" className={th}>{t('skills.columns.role')}</th>
            <th scope="col" className={th}>{t('skills.columns.waiting')}</th>
            <th scope="col" className={th}>{t('skills.columns.current')}</th>
            <th scope="col" className={th}>{t('skills.columns.template')}</th>
            <th scope="col" className={th}>{t('skills.columns.lastChange')}</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {rolesInOrder(roles).map((line) => (
            <tr key={line.role}>
              <th scope="row" className="px-3 py-2 text-left text-sm font-normal">
                <button type="button" className="link text-left" onClick={() => onOpen(line.role)}
                  aria-label={t('skills.openRole', { role: t(`skills.role.${line.role}`) })}>
                  {t(`skills.role.${line.role}`)}
                </button>
              </th>
              <td className="px-3 py-2 text-sm"><WaitingCell line={line} onReview={(version) => onReview(line.role, version)} /></td>
              <td className="px-3 py-2 text-sm">
                {line.current_version === 0 ? <span className="text-muted">{t('skills.noneAccepted')}</span>
                  : t('skills.version', { version: line.current_version })}
              </td>
              <td className="px-3 py-2 text-sm"><TemplateCell failed={failed} card={cards.get(line.role)} onReview={() => onOpen(line.role)} /></td>
              <td className="px-3 py-2 text-sm">
                {line.latest !== null && (
                  <div className="space-y-1">
                    <SkillStatusBadge status={line.latest.status} current={line.latest.version === line.current_version} />
                    <p className="break-words [overflow-wrap:anywhere]">{line.latest.summary}</p>
                    <p className="text-[12px] text-muted">{format.at(line.latest.proposed_at)}</p>
                  </div>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
