/**
 * @fileoverview Test data: a workspace's stored design system with nothing in it yet (no tokens, guidelines or
 * references, no integration on), as `GET /design-system` answers it; `fields` replace its own.
 *
 * @module test/designSystemFixtures
 */
export function emptyDesignSystem(fields: Record<string, unknown> = {}) {
  return {
    tokens: { colors: [], typography: [], spacing: [], radius: [] },
    guidelines: '',
    references: [],
    integrations: { figma: false, github: false },
    ...fields,
  }
}
