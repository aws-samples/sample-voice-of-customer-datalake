/**
 * @fileoverview `utils/labelKnownIds` bound to the configured categories, the
 * source profiles and the caller's project list (all shared, cached queries).
 * While they load every id still reads as its humanised form, so text is never
 * blank and never a raw id.
 *
 * @module hooks/useLabelKnownIds
 */
import { useCallback, useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { projectsApi } from '../api/projectsApi'
import { projectsKey } from '../api/projectQueryKeys'
import { labelKnownIds } from '../utils/labelKnownIds'
import type { IdLabellers } from '../utils/labelKnownIds'
import { useCategoriesConfig } from './useCategories'
import { useDisplayLabels } from './useDisplayLabels'

/** A project id as its name (from the caller's project list), else "a project" — never the id. */
export function useProjectName(): (projectId: string) => string {
  const { t } = useTranslation('projects')
  const { data: projects } = useQuery({ queryKey: projectsKey(), queryFn: projectsApi.getProjects })
  return useCallback(
    (projectId: string) => projects?.projects.find((p) => p.project_id === projectId)?.name ?? t('aProject'),
    [projects, t],
  )
}

/** A function that relabels the ids inside a piece of text. */
export function useLabelKnownIds(): (text: string) => string {
  const labels = useDisplayLabels()
  const projectName = useProjectName()
  const { data: config } = useCategoriesConfig()
  const labellers = useMemo((): IdLabellers => {
    const categoryIds = new Set((config?.categories ?? []).map((c) => c.name))
    return {
      category: labels.category,
      isCategory: (id) => categoryIds.has(id),
      source: labels.source,
      project: projectName,
      unknownProject: projectName(''),
    }
  }, [config, labels, projectName])
  return useCallback((text: string) => labelKnownIds(text, labellers), [labellers])
}
