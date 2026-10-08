/**
 * @fileoverview The module stubs every whole-page Prioritization spec installs.
 *
 * Import this FIRST in a spec — before `./prioritization-render-fixtures`, which imports
 * the page. `vi.mock` registers when this module is evaluated, so the page's own imports
 * of these modules resolve to the stubs. A spec that needs a further stub (the auth
 * store, the rows API) still declares that one itself.
 */
import { vi } from 'vitest'
import {
  projectsApiModule, clientApiModule, configStoreModule, reactMarkdownModule,
} from './prioritization-fixtures'

vi.mock('../../api/projectsApi', () => projectsApiModule())
vi.mock('../../api/client', () => clientApiModule())
vi.mock('../../store/configStore', () => configStoreModule())
vi.mock('react-markdown', () => reactMarkdownModule())
