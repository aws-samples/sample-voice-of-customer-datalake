/**
 * @fileoverview Fixtures shared by the DocumentExportMenu specs.
 */
import type { ProjectDocument } from '../../api/types'
import type { Project } from '../../api/projectTypes'

/** A PRD document; override what the case is about. */
export function prdDocument(overrides: Partial<ProjectDocument> = {}): ProjectDocument {
  return {
    document_id: 'doc-1',
    document_type: 'prd',
    title: 'Test PRD',
    content: '# Overview\n\nTest content.',
    created_at: '2025-01-01T00:00:00Z',
    ...overrides,
  }
}

/** An active project with no export prompts; override what the case is about. */
export function exportProject(overrides: Partial<Project> = {}): Project {
  return {
    project_id: 'proj-1',
    name: 'Test Project',
    description: 'desc',
    status: 'active',
    created_at: '2025-01-01T00:00:00Z',
    updated_at: '2025-01-01T00:00:00Z',
    persona_count: 0,
    document_count: 0,
    ...overrides,
  }
}
