/**
 * @fileoverview Notice for an additive persona run that dropped new personas (#353).
 *
 * In add mode the backend drops a new persona whose name repeats a kept one
 * (`shared/persona_overlap.drop_name_clashes`) and reports the count as
 * `metadata.duplicate_names_dropped`. Without this line, a run asked for 3 that
 * stored 1 would read as a failed generation.
 *
 * @module pages/ProjectDetail/DuplicateNamesNotice
 */
import { useTranslation } from 'react-i18next'
import { parseJobGrounding } from '../../api/jobGroundingSchema'
import type { ProjectJob } from '../../api/projectTypes'

export default function DuplicateNamesNotice({ job }: { readonly job: ProjectJob }) {
  const { t } = useTranslation('projectDetail')
  const dropped = parseJobGrounding(job.result?.metadata).duplicate_names_dropped
  if (dropped === undefined || dropped === 0) return null
  return (
    <p data-testid="duplicate-names-dropped" className="text-xs text-warn mt-1">
      {t('jobs.duplicateNamesDropped', { count: dropped })}
    </p>
  )
}
