/**
 * @fileoverview What the Skills tab's Library list (SkillLibrary.tsx) and a skill's page (SkillLibraryDetail.tsx)
 * share (7.56.00): a skill's summary, its description, where it came from and the roles that use it.
 *
 * @module pages/Agents/SkillLibraryParts
 */
import { Link } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { registryCardPath } from './Registry/registryPaths'
import type { LibrarySkill } from '../../api/engineeringSkillLibraryApi'

/** The roles that use a skill, each linking to its Registry card; "No role uses it" for none. */
function SkillUsedBy({ roles }: Readonly<{ roles: readonly string[] }>) {
  const { t } = useTranslation('agents')
  if (roles.length === 0) return <span className="text-muted">{t('skills.library.usedByNone')}</span>
  return (
    <ul className="inline-flex flex-wrap gap-x-2 gap-y-1">
      {roles.map((role) => (
        <li key={role}>
          <Link to={registryCardPath(role)} className="link">{t(`skills.role.${role}`, { defaultValue: role })}</Link>
        </li>
      ))}
    </ul>
  )
}

/** Where a skill came from, under which licence, and what was adapted. */
function SkillProvenance({ skill }: Readonly<{ skill: LibrarySkill }>) {
  const { t } = useTranslation('agents')
  return (
    <>
      <p className="text-[12px] text-muted">{t('skills.library.sourceLine', { source: skill.source, license: skill.license })}</p>
      {skill.adapted !== '' && <p className="text-[12px] text-muted">{t('skills.library.adaptedLine', { adapted: skill.adapted })}</p>}
    </>
  )
}

/** A skill's description, where it came from, and the roles that use it. */
export function SkillSummary({ skill }: Readonly<{ skill: LibrarySkill }>) {
  const { t } = useTranslation('agents')
  return (
    <>
      <p className="text-sm text-text">{skill.description}</p>
      <SkillProvenance skill={skill} />
      <div className="flex flex-wrap items-baseline gap-2 text-[12px]">
        <span className="font-semibold text-muted">{t('skills.library.usedBy')}</span>
        <SkillUsedBy roles={skill.roles} />
      </div>
    </>
  )
}
