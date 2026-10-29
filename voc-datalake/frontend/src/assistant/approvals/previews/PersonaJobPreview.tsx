/**
 * @fileoverview Preview for `generate_personas` (#353): the job card, plus what the run
 * does to the project's current personas. `keep_existing_personas` absent or true adds
 * next to them (the default); false deletes them first, which the card states in danger
 * colours with the count, so nobody approves a replace without seeing it.
 *
 * @module assistant/approvals/previews/PersonaJobPreview
 */
import { AlertTriangle } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { isRecord } from '../../../lib/typeGuards'
import { JobPreview } from './JobPreview'
import { useProjectDetail } from './useProjectDetail'

/** The args as the job card lists them: the mode has its own line below. */
function withoutMode(args: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(args).filter(([key]) => key !== 'keep_existing_personas'))
}

function ModeLine({ replace, existing }: Readonly<{ replace: boolean; existing: number | undefined }>) {
  const { t } = useTranslation('assistantTools')
  if (existing === 0) return null
  if (!replace) {
    return (
      <p data-testid="persona-mode" className="text-[12px] text-text">
        {existing === undefined ? t('preview.personas.addUnknown') : t('preview.personas.add', { count: existing })}
      </p>
    )
  }
  return (
    <p data-testid="persona-mode" className="rounded-md border border-danger/30 bg-danger-subtle p-2 text-[12px] text-danger inline-flex items-start gap-1.5">
      <AlertTriangle size={14} aria-hidden="true" className="mt-0.5 shrink-0" />
      {existing === undefined ? t('preview.personas.replaceUnknown') : t('preview.personas.replace', { count: existing })}
    </p>
  )
}

export function PersonaJobPreview({ args }: Readonly<{ args: unknown }>) {
  const projectId = isRecord(args) && typeof args.project_id === 'string' ? args.project_id : ''
  const { data } = useProjectDetail(projectId)
  if (!isRecord(args)) return null
  return (
    <div className="space-y-2">
      <ModeLine replace={args.keep_existing_personas === false} existing={data?.personas.length} />
      <JobPreview args={withoutMode(args)} />
    </div>
  )
}
