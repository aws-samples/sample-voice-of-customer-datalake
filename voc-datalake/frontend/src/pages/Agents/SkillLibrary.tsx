/**
 * @fileoverview Agents → Skills → Library (7.56.00): the engineering agents' default skills, vendored into the
 * repository (`templates/orchestration/skills/<name>/`, compiled into the orchestration bundle;
 * `GET /agents/engineering/skill-library`). Each skill shows its description, where it came from and under which
 * licence, what was adapted, and the roles that use it (a role's prompt lists its skills and it reads one with its
 * `read_skill` tool). A skill opens on its own page (SkillLibraryDetail.tsx): its SKILL.md and each reference file,
 * read only on the shared document component. The library is the release's, the same in every scope.
 *
 * @module pages/Agents/SkillLibrary
 */
import { Link } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import LoadFailed from '../../components/LoadFailed/LoadFailed'
import { libraryPath } from './skillLibraryPaths'
import { SkillLibraryDetail } from './SkillLibraryDetail'
import { SkillSummary } from './SkillLibraryParts'
import { useSkillLibrary } from './useSkillLibrary'
import type { LibrarySkill } from '../../api/engineeringSkillLibraryApi'
import type { LibraryPlace } from './skillLibraryPaths'

function LibraryItem({ skill }: Readonly<{ skill: LibrarySkill }>) {
  const { t } = useTranslation('agents')
  return (
    <li aria-label={skill.name} className="card space-y-1.5 p-4">
      <div className="flex flex-wrap items-center gap-2">
        <Link to={libraryPath({ skill: skill.name })} className="link font-mono text-sm font-semibold"
          aria-label={t('skills.library.open', { name: skill.name })}>{skill.name}</Link>
        {skill.license !== '' && <span className="badge badge-muted">{skill.license}</span>}
      </div>
      <SkillSummary skill={skill} />
    </li>
  )
}

function LibraryList() {
  const { t } = useTranslation('agents')
  const read = useSkillLibrary()
  return (
    <div aria-busy={read.isFetching} className="space-y-3">
      <p className="text-sm text-muted max-w-prose">{t('skills.library.hint')}</p>
      {read.isLoading && <div className="skeleton h-24" role="status" aria-label={t('skills.library.loading')} />}
      {read.isError && <LoadFailed message={t('skills.library.failed')} onRetry={() => void read.refetch()} retrying={read.isFetching} />}
      {read.data?.length === 0 && <p className="card p-6 text-center text-sm text-muted">{t('skills.library.empty')}</p>}
      {read.data !== undefined && read.data.length > 0 && (
        <ul aria-label={t('skills.library.listLabel')} className="space-y-3">
          {read.data.map((skill) => <LibraryItem key={skill.name} skill={skill} />)}
        </ul>
      )}
    </div>
  )
}

/** The library's list, or one of its skills (`place.skill`). */
export function SkillLibrary({ place }: Readonly<{ place: LibraryPlace }>) {
  return place.skill === null ? <LibraryList /> : <SkillLibraryDetail key={place.skill} name={place.skill} reference={place.reference} />
}
