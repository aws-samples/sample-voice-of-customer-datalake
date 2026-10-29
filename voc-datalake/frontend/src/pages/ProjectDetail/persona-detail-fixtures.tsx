/**
 * @fileoverview Spec support: PersonaDetailView rendered with no-op handlers (test-only, like every
 * `*-fixtures.tsx`).
 */
import { vi } from 'vitest'
import { renderWithQueryClient } from '../../test/query-client'
import PersonaDetailView from './PersonaDetailView'
import type { ProjectPersona } from '../../api/projectTypes'

export function renderPersonaDetail(persona: ProjectPersona, { canEdit = true, projectId = 'proj_1' } = {}) {
  return renderWithQueryClient(
    <PersonaDetailView projectId={projectId} persona={persona} canEdit={canEdit}
      onEdit={vi.fn()} onDelete={vi.fn()} onSaveNotes={vi.fn()} isDeleting={false} isSavingNotes={false} />,
  )
}
