/**
 * @fileoverview Spec support: PersonaDetailView rendered with no-op handlers (test-only, like every
 * `*-fixtures.tsx`).
 */
import { vi } from 'vitest'
import { renderWithQueryClient } from '../../test/query-client'
import PersonaDetailView from './PersonaDetailView'
import { projectPersonaScope } from './personaScope'
import type { PersonaScope } from './personaScope'
import type { ProjectPersona } from '../../api/projectTypes'

export function renderPersonaDetail(
  persona: ProjectPersona,
  { canEdit = true, scope = projectPersonaScope('proj_1') }: { canEdit?: boolean; scope?: PersonaScope } = {},
) {
  return renderWithQueryClient(
    <PersonaDetailView scope={scope} persona={persona} canEdit={canEdit}
      onEdit={vi.fn()} onDelete={vi.fn()} onSaveNotes={vi.fn()} isDeleting={false} isSavingNotes={false} />,
  )
}
