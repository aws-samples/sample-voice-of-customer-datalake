/**
 * @fileoverview Tests for Breadcrumbs component.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { render, screen } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import i18n from 'i18next'
import { TestRouter } from '../../test/test-utils'
import { routes } from '../../App'
import Breadcrumbs from './Breadcrumbs'
import { RECORD_CRUMBS, SEGMENT_CRUMBS } from './routeCrumbs'
import deCommon from '../../../public/locales/de/common.json'

const PROJECT_ID = 'proj_20260101120000'

function createQueryClient() {
  return new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })
}

/**
 * @param seed populates the query cache the way the page on that route would
 *   have, so the header can be asserted both before and after the page's own
 *   fetch resolves.
 */
function renderWithRouter(
  initialEntries: string[] = ['/'],
  seed?: (client: QueryClient) => void,
) {
  const queryClient = createQueryClient()
  seed?.(queryClient)
  return render(
    <QueryClientProvider client={queryClient}>
      <TestRouter initialEntries={initialEntries}>
        <Breadcrumbs />
      </TestRouter>
    </QueryClientProvider>,
  )
}

describe('Breadcrumbs', () => {
  describe('visibility', () => {
    it('returns null on home page', () => {
      const { container } = renderWithRouter(['/'])
      expect(container.firstChild).toBeNull()
    })

    it('renders breadcrumbs on non-home pages', () => {
      renderWithRouter(['/categories'])
      expect(screen.getByRole('navigation', { name: /breadcrumb/i })).toBeInTheDocument()
    })
  })

  describe('route labels', () => {
    it('displays correct label for dashboard route', () => {
      renderWithRouter(['/dashboard'])
      expect(screen.getByText('Dashboard')).toBeInTheDocument()
    })

    it('displays correct label for categories route', () => {
      renderWithRouter(['/categories'])
      expect(screen.getByText('Categories')).toBeInTheDocument()
    })

    it('displays correct label for chat route', () => {
      renderWithRouter(['/chat'])
      expect(screen.getByText('AI Chat')).toBeInTheDocument()
    })

    it('displays correct label for scrapers route', () => {
      renderWithRouter(['/scrapers'])
      expect(screen.getByText('Web Scrapers')).toBeInTheDocument()
    })

    it('displays correct label for settings route', () => {
      renderWithRouter(['/settings'])
      expect(screen.getByText('Settings')).toBeInTheDocument()
    })

    it('displays correct label for projects route', () => {
      renderWithRouter(['/projects'])
      expect(screen.getByText('Projects')).toBeInTheDocument()
    })

    it('displays correct label for data-explorer route', () => {
      renderWithRouter(['/data-explorer'])
      expect(screen.getByText('Data Explorer')).toBeInTheDocument()
    })

    it('displays correct label for prioritization route', () => {
      renderWithRouter(['/prioritization'])
      expect(screen.getByText('Prioritization')).toBeInTheDocument()
    })

    it('displays correct label for problems route', () => {
      renderWithRouter(['/problems'])
      expect(screen.getByText('Problem Analysis')).toBeInTheDocument()
    })

    it('falls back to segment name for unknown routes', () => {
      renderWithRouter(['/unknown-route'])
      expect(screen.getByText('unknown-route')).toBeInTheDocument()
    })

    // /feedback only redirects to /categories since the list page was
    // consolidated (#198), so the crumb names where the link actually goes.
    it('labels the legacy /feedback segment as Categories and links there', () => {
      renderWithRouter([`/feedback/${PROJECT_ID}`])
      const parent = screen.getByRole('link', { name: 'Categories' })
      expect(parent).toHaveAttribute('href', '/categories')
      expect(screen.queryByText('Feedback')).not.toBeInTheDocument()
    })
  })

  describe('record ids', () => {
    it('shows a generic label instead of a project id', () => {
      renderWithRouter([`/projects/${PROJECT_ID}`])
      expect(screen.getByText('Project')).toBeInTheDocument()
      expect(screen.queryByText(PROJECT_ID)).not.toBeInTheDocument()
    })

    it("shows the project's name once the page has loaded it", () => {
      renderWithRouter([`/projects/${PROJECT_ID}`], (client) => {
        client.setQueryData(['project', PROJECT_ID], {
          project: { project_id: PROJECT_ID, name: 'Checkout Friction' },
          personas: [],
          documents: [],
        })
      })
      expect(screen.getByText('Checkout Friction')).toBeInTheDocument()
      expect(screen.queryByText(PROJECT_ID)).not.toBeInTheDocument()
    })

    // A record saved before `name` existed, or an error state, must not throw
    // in the page header — nor leak the id as a fallback.
    it('keeps the generic label when the cached record has no usable name', () => {
      renderWithRouter([`/projects/${PROJECT_ID}`], (client) => {
        client.setQueryData(['project', PROJECT_ID], { project: { name: '   ' } })
      })
      expect(screen.getByText('Project')).toBeInTheDocument()
      expect(screen.queryByText(PROJECT_ID)).not.toBeInTheDocument()
    })

    it('shows a generic label instead of a feedback id', () => {
      renderWithRouter(['/feedback/fb_123'])
      expect(screen.getByText('Feedback item')).toBeInTheDocument()
      expect(screen.queryByText('fb_123')).not.toBeInTheDocument()
    })
  })

  describe('navigation structure', () => {
    it('includes Home link as first breadcrumb', () => {
      renderWithRouter(['/categories'])
      const homeLink = screen.getByRole('link')
      expect(homeLink).toHaveAttribute('href', '/')
    })

    it('marks current page with aria-current', () => {
      renderWithRouter(['/categories'])
      // The current page span has aria-current="page" - find by aria attribute
      const currentPage = screen.getByText('Categories').closest('[aria-current="page"]')
      expect(currentPage).toBeInTheDocument()
    })

    it('renders nested routes correctly', () => {
      renderWithRouter([`/projects/${PROJECT_ID}`])
      expect(screen.getByText('Projects')).toBeInTheDocument()
      expect(screen.getByText('Project')).toBeInTheDocument()
    })
  })

  describe('link behavior', () => {
    it('renders intermediate segments as links', () => {
      renderWithRouter([`/projects/${PROJECT_ID}`])
      const projectsLink = screen.getByRole('link', { name: 'Projects' })
      expect(projectsLink).toHaveAttribute('href', '/projects')
    })

    it('does not render last segment as link', () => {
      renderWithRouter(['/categories'])
      // Categories should be a span, not a link
      const categoriesText = screen.getByText('Categories')
      expect(categoriesText.tagName).not.toBe('A')
    })

    // The label is hidden below `sm` and an intermediate crumb has no icon, so
    // without an aria-label these links have no accessible name on a phone.
    it('names intermediate links for assistive technology', () => {
      renderWithRouter([`/projects/${PROJECT_ID}`])
      expect(screen.getByRole('link', { name: 'Projects' })).toBeInTheDocument()
    })
  })

  describe('chevron separators', () => {
    it('renders chevron between breadcrumb items', () => {
      renderWithRouter(['/categories'])
      // Should have chevron between Home and Categories
      const chevrons = document.querySelectorAll('.lucide-chevron-right')
      expect(chevrons.length).toBe(1)
    })

    it('renders multiple chevrons for nested routes', () => {
      renderWithRouter([`/projects/${PROJECT_ID}`])
      const chevrons = document.querySelectorAll('.lucide-chevron-right')
      expect(chevrons.length).toBe(2)
    })

    it('chevrons have aria-hidden attribute', () => {
      renderWithRouter(['/categories'])
      const chevron = document.querySelector('.lucide-chevron-right')
      expect(chevron).toHaveAttribute('aria-hidden', 'true')
    })
  })

  describe('home icon', () => {
    it('renders home icon in home breadcrumb link', () => {
      renderWithRouter(['/categories'])
      // Home icon is inside the link
      const homeLink = screen.getByRole('link')
      expect(homeLink).toBeInTheDocument()
    })

    it('home link contains home icon', () => {
      renderWithRouter(['/categories'])
      const homeLink = screen.getByRole('link')
      const homeIcon = homeLink.querySelector('svg')
      expect(homeIcon).toBeInTheDocument()
    })
  })

  describe('accessibility', () => {
    it('has navigation landmark with breadcrumb label', () => {
      renderWithRouter(['/categories'])
      const nav = screen.getByRole('navigation', { name: /breadcrumb/i })
      expect(nav).toBeInTheDocument()
    })
  })

  describe('feedback-forms route', () => {
    it('displays correct label for feedback-forms route', () => {
      renderWithRouter(['/feedback-forms'])
      expect(screen.getByText('Feedback Forms')).toBeInTheDocument()
    })
  })

  /**
   * Every case above runs under `en`, where a hardcoded English literal and its
   * translation are the same string — so none of them can fail on the map of
   * English labels this component used to carry. These render under `de` and
   * assert the shipped German catalogue reaches the DOM, which is the only
   * assertion that fails if someone puts literals back.
   *
   * Expected strings are read from the catalogue, so rewording a translation
   * does not break the test — only unwiring the component does.
   */
  describe('localization', () => {
    const de = deCommon.breadcrumbs

    beforeAll(async () => {
      i18n.addResourceBundle('de', 'common', deCommon)
      await i18n.changeLanguage('de')
    })

    afterAll(async () => {
      await i18n.changeLanguage('en')
    })

    it('translates static route labels', () => {
      expect(i18n.language).toBe('de')
      renderWithRouter(['/data-explorer'])
      expect(screen.getByText(de.dataExplorer)).toBeInTheDocument()
      expect(screen.queryByText('Data Explorer')).not.toBeInTheDocument()
    })

    it('translates the home crumb and the record stand-in label', () => {
      renderWithRouter([`/projects/${PROJECT_ID}`])
      expect(screen.getByRole('link', { name: de.home })).toBeInTheDocument()
      expect(screen.getByText(de.project)).toBeInTheDocument()
      expect(screen.queryByText('Home')).not.toBeInTheDocument()
    })

    it('leaves a record name untranslated, since it is data and not a label', () => {
      renderWithRouter([`/projects/${PROJECT_ID}`], (client) => {
        client.setQueryData(['project', PROJECT_ID], {
          project: { project_id: PROJECT_ID, name: 'Checkout Friction' },
        })
      })
      expect(screen.getByText('Checkout Friction')).toBeInTheDocument()
    })
  })
})

/**
 * Holds the component's route tables to the real router (issue U14).
 *
 * A segment with no entry falls back to printing itself, which is how
 * `/projects/:id` came to render `proj_…` at the end of the trail. Adding a page
 * without a breadcrumb label, or a second `/thing/:id` route, would reintroduce
 * that silently — this fails instead.
 */
describe('route coverage', () => {
  const layoutRoutes = routes.find((route) => route.path === '/')?.children ?? []
  // Only routes under the layout matter: /login renders no breadcrumbs.
  const paths = layoutRoutes.map((route) => route.path).filter((path): path is string => path != null)

  it('finds the layout routes', () => {
    // Anti-vacuous guard: an empty list would make every case below pass.
    expect(paths.length).toBeGreaterThan(10)
  })

  it('has a label for every static route segment', () => {
    const unlabelled = paths
      .flatMap((path) => path.split('/'))
      .filter((segment) => !segment.startsWith(':') && SEGMENT_CRUMBS[segment] === undefined)
    expect(unlabelled).toStrictEqual([])
  })

  // Mirrors how the component resolves a record crumb: the segment BEFORE the
  // param is what carries the stand-in label.
  it('has a stand-in label for every route segment that is a record id', () => {
    const unnamed = paths.flatMap((path) => {
      const segments = path.split('/')
      return segments
        .filter((segment, index) =>
          segment.startsWith(':') && RECORD_CRUMBS[segments[index - 1] ?? ''] === undefined)
        .map((segment) => `${path} → ${segment}`)
    })
    expect(unnamed).toStrictEqual([])
  })
})
