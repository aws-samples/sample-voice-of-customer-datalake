/**
 * @fileoverview Spec support for the ProductTab specs.
 *
 * Every ProductTab spec mocks the same slice of `projectsApi` — the context
 * read and write, the upload list, the interview and the report job — and
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
  productContextInterview: unknownFn(),
  generateProductReport: unknownFn(),
}

/** `vi.mock('../../api/projectsApi', () => productTabApiModule())` */
export function productTabApiModule() {
  return {
    projectsApi: {
      getProductContext: (...args: unknown[]) => productTabMocks.getProductContext(...args),
      updateProductContext: (...args: unknown[]) => productTabMocks.updateProductContext(...args),
      listProductDocs: (...args: unknown[]) => productTabMocks.listProductDocs(...args),
      productContextInterview: (...args: unknown[]) => productTabMocks.productContextInterview(...args),
      generateProductReport: (...args: unknown[]) => productTabMocks.generateProductReport(...args),
      getProductDocUploadUrl: vi.fn(),
    },
  }
}
