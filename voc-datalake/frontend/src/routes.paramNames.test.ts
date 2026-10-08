/**
 * Every page that reads route params reads the names `routes.tsx` declares.
 *
 * Regression for the agent detail page: the route was `agents/:id`, the page
 * destructured `agentId` from `useParams()`, and its spec registered its own
 * `/agents/:agentId` — so every spec passed while the real router left the id
 * empty, the page requested `/agents/` and showed "This agent doesn't exist" for
 * every agent. A spec route that is not the production route proves nothing
 * about the param name, so the production table is checked here instead.
 *
 * The table is read as data (pages are lazy, nothing renders) and each page's
 * `useParams` destructuring is read from its source.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it, expect } from 'vitest'
import type { RouteObject } from 'react-router-dom'
import { sortedStrings } from '@test/stringLists'
import { routes } from './routes'

/** Route path in `routes.tsx` → the page module that renders it (relative to src/). */
const PARAM_PAGES: Record<string, string> = {
  '/vote/:sessionId': 'pages/Vote/Vote.tsx',
  'feedback/:id': 'pages/FeedbackDetail/FeedbackDetail.tsx',
  'projects/:id': 'pages/ProjectDetail/ProjectDetail.tsx',
  'agents/:id': 'pages/Agents/AgentDetail.tsx',
}

const read = (file: string) => readFileSync(join(__dirname, file), 'utf8')

function allPaths(table: RouteObject[]): string[] {
  return table.flatMap((route) => [...(route.path === undefined ? [] : [route.path]), ...allPaths(route.children ?? [])])
}

const declaredParams = (path: string) => [...path.matchAll(/:(\w+)/g)].map((m) => m[1])

/** The keys of `const { a, b: alias = '' } = useParams…()` in a page's source. */
function readParams(source: string): string[] {
  const match = /const \{([^}]*)\} = useParams\b/.exec(source)
  if (!match) return []
  return (match[1] ?? '').split(',').map((part) => (part.split(/[:=]/)[0] ?? '').trim()).filter(Boolean)
}

describe('route params', () => {
  const paths = allPaths(routes)

  it.each(Object.entries(PARAM_PAGES))('%s is declared in routes.tsx', (path) => {
    expect(paths).toContain(path)
  })

  it.each(Object.entries(PARAM_PAGES))('%s: the page reads only params the route declares', (path, file) => {
    const pageParams = readParams(read(file))
    expect(pageParams.length, `${file} no longer destructures useParams()`).toBeGreaterThan(0)
    expect(declaredParams(path)).toStrictEqual(expect.arrayContaining(pageParams))
  })

  it('every parameterised route is listed here', () => {
    // A new `:param` route must be added above, so its page gets the same check.
    expect(sortedStrings(paths.filter((path) => path.includes(':')))).toStrictEqual(sortedStrings(Object.keys(PARAM_PAGES)))
  })

  it('the agent detail spec registers the production route', () => {
    expect(read('pages/Agents/AgentDetail.test.tsx')).toContain("const AGENT_DETAIL_PATH = '/agents/:id'")
  })
})
