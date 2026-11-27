/**
 * @fileoverview Spec support for the ProductTab specs.
 *
 * Every ProductTab spec mocks the same slice of `projectsApi` — the context
 * read and write, the sources list, the report job and (7.104.00) the jobs list
 * and the latest proposal, which answer none by default — and
 * differs only in which of them it drives. The mocks live here once; each spec
 * pulls the ones it reads under its own local name.
 *
 * Imports no component on purpose: the specs' `vi.mock` factories call
 * `productTabApiModule`, so this module must be evaluated before ProductTab
 * (and its `projectsApi` import) is.
 */
import { vi } from 'vitest'
import { unknownFn } from './project-detail-fixtures'

/** The `projectsApi` methods the Product tab calls, as mocks the specs arm per test. */
export const productTabMocks = {
  getProductContext: unknownFn(),
  updateProductContext: unknownFn(),
  listProductDocs: unknownFn(),
  generateProductReport: unknownFn(),
  getJobs: vi.fn<(...args: unknown[]) => unknown>(() => Promise.resolve({ success: true, jobs: [] })),
  getLatestProductProposal: vi.fn<(...args: unknown[]) => unknown>(() => Promise.resolve({ proposal: null, context: {}, field_meta: {}, sources: [] })),
}

/**
 * `vi.mock('./CompanyContextStrip', () => companyStripModule())`: the strip reads the
 * company context and design system through their own queries, which no Product tab
 * spec is about.
 */
export function companyStripModule() {
  return { default: () => null }
}

/** `vi.mock('../../api/projectsApi', () => productTabApiModule())` */
export function productTabApiModule() {
  return {
    projectsApi: {
      getProductContext: (...args: unknown[]) => productTabMocks.getProductContext(...args),
      updateProductContext: (...args: unknown[]) => productTabMocks.updateProductContext(...args),
      listProductDocs: (...args: unknown[]) => productTabMocks.listProductDocs(...args),
      generateProductReport: (...args: unknown[]) => productTabMocks.generateProductReport(...args),
      getJobs: (...args: unknown[]) => productTabMocks.getJobs(...args),
      getLatestProductProposal: (...args: unknown[]) => productTabMocks.getLatestProductProposal(...args),
      getProductDocUploadUrl: vi.fn(),
    },
  }
}
