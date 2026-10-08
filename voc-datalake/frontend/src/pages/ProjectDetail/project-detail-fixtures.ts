/**
 * @fileoverview Spec support shared across the ProjectDetail page specs.
 *
 * Object builders, `vi.mock` module factories and a QueryClient helper that
 * several specs used to copy verbatim. knip treats `*-fixtures.tsx` as test
 * support, so nothing here ships in the production bundle.
 */
import { vi, beforeAll, afterAll } from 'vitest'
import { QueryClient } from '@tanstack/react-query'
import { stubElementScrollTo } from '../../test/stubScrollTo'
import { emptyProductContext } from './productContextFields'
import type { ProjectDocument } from '../../api/types'
import type { ProductContext, Project, ProjectPersona } from '../../api/projectTypes'

/**
 * Stubs `Element.scrollTo` for the enclosing `describe`, restoring it afterwards.
 *
 * The Product tab's default mode renders the AI interview, whose effect scrolls
 * the transcript. jsdom has no Element.scrollTo, and the resulting exception
 * renders the whole tab as an empty div — which would turn "the callback was not
 * called" into a vacuous pass. Restored so the stub cannot leak into another
 * file's expectations.
 */
export function stubScrollToForSuite() {
  const restore: { value: () => void } = { value: () => {} }
  beforeAll(() => {
    restore.value = stubElementScrollTo()
  })
  afterAll(() => {
    restore.value()
  })
}

/** The API endpoint every ProjectDetail spec reports from the config store. */
const TEST_API_ENDPOINT = 'https://api.example.com/v1'

/** `vi.mock('../../store/configStore', () => configStoreModule())` */
export function configStoreModule() {
  return {
    useConfigStore: () => ({ config: { apiEndpoint: TEST_API_ENDPOINT } }),
  }
}

/** A minimal active project; override whatever a spec needs to differ. */
export function makeProject(overrides: Partial<Project> = {}): Project {
  return {
    project_id: 'proj-123',
    name: 'Test Project',
    description: 'A test project',
    status: 'active',
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    persona_count: 0,
    document_count: 0,
    ...overrides,
  }
}

/** The project the whole-page specs load at `/projects/proj-1`. */
export const PAGE_PROJECT: Project = makeProject({
  project_id: 'proj-1',
  name: 'Reader Engagement',
  description: '',
  created_at: '2026-08-01T10:00:00Z',
  updated_at: '2026-08-01T10:00:00Z',
})

/** A persona row with the fields the pickers and tabs read. */
export function makePersona(overrides: Partial<ProjectPersona> = {}): ProjectPersona {
  return {
    persona_id: 'p1',
    name: 'Persona A',
    tagline: 'Tag A',
    created_at: '',
    ...overrides,
  }
}

/** A document row; defaults to a PRD because that is the commonest type under test. */
export function makeDocument(overrides: Partial<ProjectDocument> = {}): ProjectDocument {
  return {
    document_id: 'd1',
    title: 'Doc A',
    document_type: 'prd',
    content: '',
    created_at: '',
    ...overrides,
  }
}

/** The DocumentsTab callbacks a spec stubs but never asserts on, plus the idle delete state. */
export function documentsTabStubs() {
  return {
    onEditDoc: vi.fn(),
    onDeleteDoc: vi.fn(),
    onCreateDoc: vi.fn(),
    isDeleting: false,
  }
}

/** A persona named after its id, for the Overview specs' step-state fixtures. */
export function overviewPersona(id: string): ProjectPersona {
  return makePersona({ persona_id: id, name: `Persona ${id}`, tagline: '' })
}

/** A document named after its id, for the Overview specs' step-state fixtures. */
export function overviewDoc(id: string, type: ProjectDocument['document_type']): ProjectDocument {
  return makeDocument({ document_id: id, document_type: type, title: `Doc ${id}` })
}

/** An otherwise-empty product context with exactly `fields` filled. */
export function contextWith(fields: Partial<ProductContext> = {}): ProductContext {
  return { ...emptyProductContext(), ...fields }
}

/** A QueryClient with retries off so failing queries settle immediately. */
export function createQueryClient() {
  return new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
}

/** A `vi.fn()` whose declared return type is unknown, for api-module factories. */
export function unknownFn() {
  return vi.fn<(...args: unknown[]) => unknown>()
}
