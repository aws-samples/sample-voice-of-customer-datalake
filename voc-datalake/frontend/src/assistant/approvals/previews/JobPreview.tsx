/**
 * @fileoverview Preview for the background-job tools (`start_research`,
 * `generate_document`, `generate_personas`, `merge_documents`, `build_prototype`): what will be
 * started, with persona/document ids resolved to names from the project
 * record, the time window the job will read and the language it will write
 * in — both captured when the card rendered and sent exactly as shown (see
 * shown.ts) — and a note that it runs in the background and appears in the
 * project's Jobs.
 *
 * @module assistant/approvals/previews/JobPreview
 */
import { useContext } from 'react'
import { useTranslation } from 'react-i18next'
import { ShownContext, currentJobEnvironment } from '../shown'
import { isRecord } from '../../../lib/typeGuards'
import { languageName } from '../../../utils/languageName'
import { useProjectDetail } from './useProjectDetail'
import { KeyValueList } from './ValueView'

const ID_LIST_FIELDS = new Set(['persona_ids', 'document_ids'])
/** Single document ids (`build_prototype`), shown by title like the lists. */
const ID_FIELDS = new Set(['base_prototype_id', 'source_prd_id', 'source_prfaq_id'])

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : []
}

function displayValue(key: string, value: unknown, names: ReadonlyMap<string, string>): unknown {
  if (ID_LIST_FIELDS.has(key)) return stringList(value).map((id) => names.get(id) ?? id)
  if (ID_FIELDS.has(key) && typeof value === 'string') return names.get(value) ?? value
  return value
}

export function JobPreview({ args }: Readonly<{ args: unknown }>) {
  const { t, i18n } = useTranslation('assistantTools')
  const shown = useContext(ShownContext)
  const job = shown?.job ?? currentJobEnvironment()
  const projectId = isRecord(args) && typeof args.project_id === 'string' ? args.project_id : ''
  const { data } = useProjectDetail(projectId)
  if (!isRecord(args)) return null

  const names = new Map<string, string>([
    ...(data?.personas ?? []).map((p): [string, string] => [p.persona_id, p.name]),
    ...(data?.documents ?? []).map((d): [string, string] => [d.document_id, d.title]),
  ])
  const visible = Object.fromEntries(
    Object.entries(args)
      .filter(([key]) => key !== 'project_id')
      .map(([key, value]) => [
        key,
        displayValue(key, value, names),
      ]),
  )
  return (
    <div className="space-y-2">
      <KeyValueList value={visible} />
      <p className="text-[12px] text-muted">{t('preview.job.timeWindow', { days: job.days })}</p>
      <p className="text-[12px] text-muted">{t('preview.job.language', { language: languageName(job.responseLanguage, i18n.language || 'en') })}</p>
      <p className="rounded-md border border-info/30 bg-info-subtle p-2 text-[12px] text-info">{t('preview.job.background')}</p>
    </div>
  )
}
