/**
 * @fileoverview Agents → Skills → Library → one skill (7.56.00, `/agents/skills/library/<name>[/references/<file>]`,
 * skillLibraryPaths.ts): its description, source, licence, what was adapted and the roles that use it, then its files,
 * SKILL.md and each reference, one at a time (the file is the path, so Back returns to the one before), each read
 * through the shared document component, read only (`GET …/skill-library/<name>[?reference=…]`). The SKILL.md's YAML
 * front matter is split off as Properties.
 *
 * @module pages/Agents/SkillLibraryDetail
 */
import { useQuery } from '@tanstack/react-query'
import { Link, useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { ArrowLeft } from 'lucide-react'
import LoadFailed from '../../components/LoadFailed/LoadFailed'
import PressedChoices from '../../components/PressedChoices/PressedChoices'
import { engineeringSkillLibraryApi, engineeringSkillLibraryKeys } from '../../api/engineeringSkillLibraryApi'
import { apiErrorStatus, retryOnceUnlessNotFound } from '../../api/apiErrorStatus'
import { libraryDocumentOf, libraryFileAdapter } from './documents/skillLibraryDocument'
import ReadOnlySurface from './documents/ReadOnlySurface'
import { libraryPath } from './skillLibraryPaths'
import { SkillSummary } from './SkillLibraryParts'
import { useSkillLibrary } from './useSkillLibrary'
import type { LibrarySkill } from '../../api/engineeringSkillLibraryApi'

const SKILL_FILE = 'SKILL.md'

function LibraryFile({ name, reference }: Readonly<{ name: string; reference: string | null }>) {
  const { t } = useTranslation('agents')
  const read = useQuery({
    queryKey: engineeringSkillLibraryKeys.file(name, reference),
    queryFn: async () => libraryDocumentOf(await engineeringSkillLibraryApi.file(name, reference)),
    staleTime: Infinity,
    retry: retryOnceUnlessNotFound,
  })
  if (apiErrorStatus(read.error) === 404) {
    return <p className="card p-6 text-center text-sm text-muted">{t('skills.library.fileMissing', { file: reference ?? SKILL_FILE })}</p>
  }
  if (read.isError) {
    return <LoadFailed message={t('skills.library.fileFailed')} onRetry={() => void read.refetch()} retrying={read.isFetching} />
  }
  const meta = read.data === undefined ? null : <p className="font-mono text-[12px] text-muted break-all">{read.data.path}</p>
  return (
    <ReadOnlySurface adapter={libraryFileAdapter(name, reference)} variant="inline" title={reference ?? SKILL_FILE}
      headingLevel={3} meta={meta} stored={read.data} mode="read" compare={null} fullPath={null} />
  )
}

function SkillFiles({ skill, reference }: Readonly<{ skill: LibrarySkill; reference: string | null }>) {
  const { t } = useTranslation('agents')
  const navigate = useNavigate()
  const files = [SKILL_FILE, ...skill.references.map((file) => file.path)]
  const open = (file: string) => {
    void navigate(libraryPath({ skill: skill.name, reference: file === SKILL_FILE ? null : file }))
  }
  return (
    <section aria-labelledby="library-files" className="space-y-3">
      <h3 id="library-files" className="text-sm font-semibold text-text-strong">{t('skills.library.files')}</h3>
      <PressedChoices label={t('skills.library.filesLabel')} choices={files} value={reference ?? SKILL_FILE} onChange={open}
        display={(file) => file} className="tabs-track w-fit flex-wrap" pressedClassName="tab tab-active" idleClassName="tab" />
      <LibraryFile key={reference ?? SKILL_FILE} name={skill.name} reference={reference} />
    </section>
  )
}

export function SkillLibraryDetail({ name, reference }: Readonly<{ name: string; reference: string | null }>) {
  const { t } = useTranslation('agents')
  const read = useSkillLibrary()
  const skill = read.data?.find((item) => item.name === name)
  return (
    <section aria-labelledby="library-skill" aria-busy={read.isFetching} className="space-y-4">
      <Link to={libraryPath()} className="btn btn-ghost btn-sm w-fit">
        <ArrowLeft size={14} aria-hidden="true" /> {t('skills.library.back')}
      </Link>
      <div className="flex flex-wrap items-center gap-2">
        <h2 id="library-skill" className="mr-auto font-mono text-lg font-semibold text-text-strong">{name}</h2>
        {skill !== undefined && skill.license !== '' && <span className="badge badge-muted">{skill.license}</span>}
      </div>
      {read.isLoading && <div className="skeleton h-24" role="status" aria-label={t('skills.library.loading')} />}
      {read.isError && <LoadFailed message={t('skills.library.failed')} onRetry={() => void read.refetch()} retrying={read.isFetching} />}
      {read.data !== undefined && skill === undefined && (
        <p className="card p-6 text-center text-sm text-muted">{t('skills.library.missing', { name })}</p>
      )}
      {skill !== undefined && (
        <>
          <div className="space-y-1.5"><SkillSummary skill={skill} /></div>
          <SkillFiles skill={skill} reference={reference} />
        </>
      )}
    </section>
  )
}
