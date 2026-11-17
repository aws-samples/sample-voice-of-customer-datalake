/**
 * @fileoverview The Registry's and the Skills' pages, each its own chunk (lazyPages.ts's rule: the route table imports
 * them without loading them). orchestrationRoutes.registry.tsx routes to them.
 *
 * @module pages/Agents/registryLazyPages
 */
import { lazy } from 'react'

export const RegistryPage = lazy(() => import('./Registry/RegistryPage'))
export const SkillsPage = lazy(() => import('./EngineeringSkills').then((module) => ({ default: module.EngineeringSkills })))
