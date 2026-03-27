/**
 * @fileoverview Shared utilities for the prioritization feature.
 * @module pages/Prioritization/prioritizationUtils
 */

import type {
  Project, ProjectDocument, PrioritizationScore,
} from '../../api/types'

export interface PRFAQWithProject extends ProjectDocument {
  project_id: string
  project_name: string
}

export type SortField = 'priority_score' | 'impact' | 'time_to_market' | 'created_at' | 'title'
export type SortDirection = 'asc' | 'desc'

export const DEFAULT_SCORE: PrioritizationScore = {
  document_id: '',
  impact: 0,
  time_to_market: 3,
  confidence: 0,
  strategic_fit: 0,
  notes: '',
}

export const calculatePriorityScore = (score: PrioritizationScore): number => {
  return (score.impact * 0.4) + (score.time_to_market * 0.3) + (score.strategic_fit * 0.2) + (score.confidence * 0.1)
}

export const getScoreColor = (score: number, max: number = 5): string => {
  const ratio = score / max
  if (ratio >= 0.8) return 'text-green-600 bg-green-50'
  if (ratio >= 0.6) return 'text-blue-600 bg-blue-50'
  if (ratio >= 0.4) return 'text-yellow-600 bg-yellow-50'
  return 'text-red-600 bg-red-50'
}

export const getPriorityLabel = (score: number, t: (key: string) => string): {
  label: string;
  color: string
} => {
  if (score >= 4) return {
    label: t('priority.high'),
    color: 'bg-green-100 text-green-800',
  }
  if (score >= 3) return {
    label: t('priority.medium'),
    color: 'bg-blue-100 text-blue-800',
  }
  if (score >= 2) return {
    label: t('priority.low'),
    color: 'bg-yellow-100 text-yellow-800',
  }
  return {
    label: t('priority.none'),
    color: 'bg-gray-100 text-gray-600',
  }
}

export function getScore(scores: Record<string, PrioritizationScore>, docId: string): PrioritizationScore {
  return scores[docId] ?? {
    ...DEFAULT_SCORE,
    document_id: docId,
  }
}

export function collectPRFAQs(allProjectDetails: Array<{ documents?: ProjectDocument[] }> | undefined, projects: Project[] | undefined): PRFAQWithProject[] {
  if (!allProjectDetails || !projects) return []

  const result: PRFAQWithProject[] = []
  for (const [index, detail] of allProjectDetails.entries()) {
    if (!detail.documents) continue
    const project = projects[index]
    const prfaqDocs = detail.documents.filter((doc: ProjectDocument) => doc.document_type === 'prfaq')
    for (const doc of prfaqDocs) {
      result.push({
        ...doc,
        project_id: project.project_id,
        project_name: project.name,
      })
    }
  }
  return result
}

export function comparePRFAQs(a: PRFAQWithProject, b: PRFAQWithProject, scores: Record<string, PrioritizationScore>, sortField: SortField): number {
  const scoreA = getScore(scores, a.document_id)
  const scoreB = getScore(scores, b.document_id)

  switch (sortField) {
    case 'priority_score': return calculatePriorityScore(scoreA) - calculatePriorityScore(scoreB)
    case 'impact': return scoreA.impact - scoreB.impact
    case 'time_to_market': return scoreA.time_to_market - scoreB.time_to_market
    case 'created_at': return new Date(a.created_at).getTime() - new Date(b.created_at).getTime()
    case 'title': return a.title.localeCompare(b.title)
  }
}
