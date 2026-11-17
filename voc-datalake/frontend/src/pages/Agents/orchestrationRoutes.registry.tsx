/**
 * @fileoverview Agent orchestration's Skills and Registry tabs as routes (7.52.00): the pages 7.52.00 C3 builds, mounted
 * under the shell (Agents.tsx, a layout route) by routes.tsx with one spread: `...registryRoutes.map(underOrchestration)`.
 *
 * The contract (C1's side, for C3's file to keep):
 * - export `registryRoutes: RouteObject[]`, the routes of `/agents/skills[/…]` and `/agents/registry[/…]`; a path may be
 *   written absolute (`/agents/registry/*`), from the app's root (`agents/registry/*`) or under the shell
 *   (`registry/*`): routes.tsx makes each one the shell's child. Give each a splat when its page has places under it;
 * - an element (or `lazy`) is the tab's CONTENT only: the shell draws the header and the tab bar above it, and wraps
 *   it in a Suspense; it neither replaces nor reads these tabs' places (agentsPaths.ts parses Skills' role and version
 *   for today's page, and leaves every place under `/agents/registry` to its page);
 * - keep this file free of components (react-refresh): load the pages with `lazy` (or from lazyPages.ts).
 *
 * This is C1's stand-in until C3's lands: today's Skills page, and an empty Registry. C3 overwrites it.
 *
 * @module pages/Agents/orchestrationRoutes.registry
 */
import type { RouteObject } from 'react-router-dom'

export const registryRoutes: RouteObject[] = [
  // Skills: the role's history `/agents/skills/<role>` and one version `/agents/skills/<role>/v/<n>` (agentsPaths.ts).
  { path: '/agents/skills/*', lazy: async () => ({ Component: (await import('./EngineeringSkills')).EngineeringSkills }) },
  // Registry, with Quality gates as its filter: C3's page; nothing until it lands.
  { path: '/agents/registry/*', element: null },
]
