/**
 * @fileoverview The Registry's and the Skills' routes (7.52.00 C3), for the Agents section's route table (C1 spreads
 * `registryRoutes` into routes.tsx's protected layout, beside the other agents routes; paths are relative to it, as
 * the table's are):
 *
 * - `agents/registry/*`: the Registry (Registry/registryPaths.ts): the cards at `/agents/registry`, its **Quality
 *   gates** filter at `/agents/registry/gates` (a brief on its own page at `/agents/registry/gates/briefs/<id>`), and
 *   one card at `/agents/registry/<card>`;
 * - `agents/skills/*`: Skills (agentsPaths.ts): the scope's roles at `/agents/skills`, a role at
 *   `/agents/skills/<role>`, one version at `/agents/skills/<role>/versions/<n>`; the scope stays in the query
 *   (`?connection=`).
 *
 * Each element is the view's content (its tab row and header are the section's); each page loads on its own, and none
 * imports the editor (build/readEngineImports.test.ts: the canvas loads on Edit only). Both static paths rank above
 * `agents/:id/*` (an agent's id is never `registry` or `skills`).
 *
 * @module pages/Agents/orchestrationRoutes.registry
 */
import { Suspense } from 'react'
import PageLoader from '../../components/PageLoader/PageLoader'
import RouteErrorBoundary from '../../components/RouteErrorBoundary'
import { RegistryPage, SkillsPage } from './registryLazyPages'
import type { ReactNode } from 'react'
import type { RouteObject } from 'react-router-dom'

/** A lazy page with the table's suspense fallback and its route-scoped error boundary (routes.tsx `page`). */
const routePage = (element: ReactNode) => ({
  element: <Suspense fallback={<PageLoader />}>{element}</Suspense>,
  errorElement: <RouteErrorBoundary />,
})

export const registryRoutes: RouteObject[] = [
  { path: 'agents/registry/*', ...routePage(<RegistryPage />) },
  { path: 'agents/skills/*', ...routePage(<SkillsPage />) },
]
