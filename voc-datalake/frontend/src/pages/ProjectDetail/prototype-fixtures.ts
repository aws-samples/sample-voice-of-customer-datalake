/**
 * @fileoverview Spec support for the prototype-build specs: the OverviewTab
 * `prototype*` family and the DocumentsTab `revision*` specs.
 *
 * All six mock `projectsApi.buildPrototype`, reset it to the same resolved job
 * before each test, render the same project and build documents from the same
 * two builders. Those live here once.
 *
 * Imports no component on purpose: the specs' `vi.mock` factories call
 * `prototypeProjectsApiModule`, so this module must be evaluated before the
 * component under test (and its `projectsApi` import) is. The render helpers that
 * need OverviewTab live in `prototype-render-fixtures.tsx`.
 */
import { vi, expect } from 'vitest'
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { UserEvent } from '@testing-library/user-event'
import { contextWith, makeProject } from './project-detail-fixtures'
import type { projectsApi } from '../../api/projectsApi'
import type { ProjectDocument } from '../../api/types'
import type { ProductContext, ProductDoc, Project } from '../../api/projectTypes'

/** The request body `projectsApi.buildPrototype` takes — what every build assertion reads. */
type BuildPrototypeBody = Parameters<typeof projectsApi.buildPrototype>[1]

/** The one `projectsApi` method a prototype build calls. */
export const prototypeMocks = {
  buildPrototype: vi.fn<(projectId: string, body: BuildPrototypeBody) => unknown>(),
}

/** `vi.mock('../../api/projectsApi', () => prototypeProjectsApiModule())` */
export function prototypeProjectsApiModule() {
  return {
    projectsApi: {
      buildPrototype: (projectId: string, body: BuildPrototypeBody) =>
        prototypeMocks.buildPrototype(projectId, body),
    },
  }
}

/** The `beforeEach` every prototype spec runs: clear, then a build that starts a job. */
export function resetPrototypeMocks() {
  vi.clearAllMocks()
  prototypeMocks.buildPrototype.mockResolvedValue({ job_id: 'job_1' })
}

/**
 * Drives the selected prototype's "Revise with feedback" flow to the point where
 * one build request has been sent, and returns that request's body.
 */
export async function reviseWithFeedback(feedback: string): Promise<BuildPrototypeBody> {
  const user = userEvent.setup()
  await user.click(screen.getByRole('button', { name: /revise with feedback/i }))
  await user.type(screen.getByRole('textbox'), feedback)
  await user.click(screen.getByRole('button', { name: /^regenerate$/i }))
  await waitFor(() => expect(prototypeMocks.buildPrototype).toHaveBeenCalledTimes(1))
  return sentBuildBody()
}

/** The body of the FIRST build request sent, failing the spec when none was. */
export function sentBuildBody(): BuildPrototypeBody {
  const call = prototypeMocks.buildPrototype.mock.calls.at(0)
  if (call === undefined) throw new Error('fixture: buildPrototype was not called')
  return call[1]
}

/** Presses the open build wizard's own "Build prototype" button — the click that spends. */
export async function clickWizardBuild(user: UserEvent) {
  await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: /^build prototype$/i }))
}

/** Confirms the open wizard's build and waits until exactly one request has been sent. */
export async function confirmWizardBuild(user: UserEvent) {
  await clickWizardBuild(user)
  await waitFor(() => expect(prototypeMocks.buildPrototype).toHaveBeenCalledTimes(1))
}

/** One hour, the lifetime the signed-URL specs measure expiry against. */
export const HOUR_MS = 60 * 60_000

/** A CloudFront-signed URL for `path`, with a distinct signature each time. */
export function signedPrototypeUrl(path: string, expiresAtMs: number, signature: string) {
  return `${path}?Expires=${Math.floor(expiresAtMs / 1000)}&Signature=${signature}&Key-Pair-Id=K1`
}

/**
 * A prototype whose HTML lives behind `prototypeUrl`. New S3-only prototypes carry
 * no inline content — the HTML is behind the URL.
 */
export function urlPrototypeDoc(prototypeUrl?: string): ProjectDocument {
  return {
    document_id: 'doc-1',
    title: 'My Prototype',
    content: '',
    document_type: 'prototype',
    prototype_format: 'html',
    prototype_url: prototypeUrl,
    created_at: new Date().toISOString(),
  }
}

/** Fully populated rather than a partial cast — a cast stops telling the truth when the type gains a field. */
export const PROTOTYPE_PROJECT: Project = makeProject({
  project_id: 'proj_1',
  name: 'Test project',
  description: '',
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z',
})

/** A document of `documentType` with an explicit creation date, for ordering tests. */
export function datedDoc(
  documentType: ProjectDocument['document_type'],
  id: string,
  title: string,
  createdAt: string,
): ProjectDocument {
  return { document_id: id, document_type: documentType, title, content: 'x', created_at: createdAt }
}

/** A prototype revision row; override whatever the test needs to differ. */
export function prototypeDoc(
  overrides: Partial<ProjectDocument> & { document_id: string },
): ProjectDocument {
  return {
    document_type: 'prototype',
    title: 'Prototype',
    content: '<!DOCTYPE html><html><body>x</body></html>',
    created_at: '2026-07-10T00:00:00Z',
    ...overrides,
  }
}

export const PRD = datedDoc('prd', 'prd_1', 'Delivery spec', '2026-01-01T00:00:00Z')
export const PRFAQ = datedDoc('prfaq', 'prfaq_1', 'Launch note', '2026-02-01T00:00:00Z')
export const RESEARCH_A = datedDoc('research', 'research_a', 'Churn interviews', '2026-03-01T00:00:00Z')
export const RESEARCH_B = datedDoc('research', 'research_b', 'Pricing survey', '2026-04-01T00:00:00Z')

/** Exactly one filled field — enough to be non-empty, few enough to stay honest. */
export const FILLED_CONTEXT: ProductContext = contextWith({ one_liner: 'A console for wombats' })

/**
 * One uploaded product doc. Defaults to a ready PNG — the only combination the
 * visual picker may offer — so every fixture states only the way it differs.
 */
export function productDoc(
  overrides: Partial<ProductDoc> & { doc_id: string; filename: string },
): ProductDoc {
  return {
    content_type: 'image/png',
    size_bytes: 1024,
    status: 'ready',
    error: null,
    extracted_chars: 400,
    created_at: '2026-05-01T00:00:00Z',
    ...overrides,
  }
}

export const VISUAL_A = productDoc({ doc_id: 'pd_a', filename: 'home-screen.png' })
