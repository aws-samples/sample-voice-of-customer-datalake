/**
 * @fileoverview A Registry card's source (gap S): its role's SKILL.md and agent.yaml as the repository holds them
 * (`GET …/templates/<kind>/<role>/source`), on the shared document component, read only (`managedByTemplate`): the
 * SKILL.md with its YAML front-matter split off byte for byte as Properties above the rendered body (Source: the body
 * as written), the agent.yaml as code in the code view. Read only when opened: a source is the template's, the card's
 * running skill version is its Skill line.
 *
 * @module pages/Agents/Registry/CardSource
 */
import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import LoadFailed from '../../../components/LoadFailed/LoadFailed'
import PressedChoices from '../../../components/PressedChoices/PressedChoices'
import { engineeringRegistryApi, engineeringRegistryKeys } from '../../../api/engineeringRegistryApi'
import { retryOnceUnlessNotFound } from '../../../api/apiErrorStatus'
import { sourceDocumentOf, templateSourceAdapter } from '../documents/templateSourceDocument'
import ReadOnlySurface from '../documents/ReadOnlySurface'

type SourceFile = 'skill' | 'card'
const FILES: readonly SourceFile[] = ['skill', 'card']
const CARD_ONLY: readonly SourceFile[] = ['card']
const FILE_NAMES: Readonly<Record<SourceFile, string>> = { skill: 'SKILL.md', card: 'agent.yaml' }

function SourceDocument({ kind, role }: Readonly<{ kind: SourceFile; role: string }>) {
  const { t } = useTranslation('agents')
  const read = useQuery({
    queryKey: engineeringRegistryKeys.source(kind, role),
    queryFn: async () => sourceDocumentOf(await engineeringRegistryApi.source(kind, role)),
    staleTime: Infinity,
    retry: retryOnceUnlessNotFound,
  })
  if (read.isError) {
    return <LoadFailed message={t('registry.card.sourceFailed')} onRetry={() => void read.refetch()} retrying={read.isFetching} />
  }
  const meta = read.data === undefined ? null : (
    <p className="flex flex-wrap items-center gap-2 text-[12px] text-muted">
      <span className="font-mono break-all">{read.data.path}</span>
      {read.data.templateVersion !== null && (
        <span className="badge badge-info">{t('registry.card.fromTemplate', { version: read.data.templateVersion })}</span>
      )}
    </p>
  )
  return (
    <ReadOnlySurface adapter={templateSourceAdapter(kind, role)} variant="inline" title={FILE_NAMES[kind]} headingLevel={3}
      meta={meta} stored={read.data} mode="read" compare={null} fullPath={null} />
  )
}

/** `skill`: the role ships a SKILL.md (the coach has none: only its agent.yaml). */
export function CardSource({ role, skill }: Readonly<{ role: string; skill: boolean }>) {
  const { t } = useTranslation('agents')
  const files = skill ? FILES : CARD_ONLY
  const [file, setFile] = useState<SourceFile>(files[0] ?? 'card')
  return (
    <section aria-labelledby="card-source" className="space-y-3">
      <h3 id="card-source" className="text-sm font-semibold text-text-strong">{t('registry.card.source')}</h3>
      <p className="text-[12px] text-muted">{t('registry.card.sourceHint')}</p>
      <PressedChoices label={t('registry.card.sourceFile')} choices={files} value={file} onChange={setFile}
        display={(choice) => FILE_NAMES[choice]} className="tabs-track w-fit" pressedClassName="tab tab-active" idleClassName="tab" />
      <SourceDocument key={file} kind={file} role={role} />
    </section>
  )
}
