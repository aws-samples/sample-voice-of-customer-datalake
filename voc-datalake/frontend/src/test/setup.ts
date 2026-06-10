/**
 * @fileoverview Vitest setup file for all tests.
 * Configures global mocks and testing utilities.
 */
import '@testing-library/jest-dom'
import { vi, afterEach } from 'vitest'
import { cleanup } from '@testing-library/react'
import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'

// Initialize i18next for tests with inline English translations.
// Avoids the HTTP backend so tests don't make network calls and so component
// assertions can match real translated strings instead of raw i18n keys.
import commonEn from '../../public/locales/en/common.json'
import dashboardEn from '../../public/locales/en/dashboard.json'
import feedbackEn from '../../public/locales/en/feedback.json'
import feedbackDetailEn from '../../public/locales/en/feedbackDetail.json'
import chatEn from '../../public/locales/en/chat.json'
import loginEn from '../../public/locales/en/login.json'
import settingsEn from '../../public/locales/en/settings.json'
import projectsEn from '../../public/locales/en/projects.json'
import categoriesEn from '../../public/locales/en/categories.json'
import componentsEn from '../../public/locales/en/components.json'
import dataExplorerEn from '../../public/locales/en/dataExplorer.json'
import feedbackFormsEn from '../../public/locales/en/feedbackForms.json'
import prioritizationEn from '../../public/locales/en/prioritization.json'
import problemAnalysisEn from '../../public/locales/en/problemAnalysis.json'
import scrapersEn from '../../public/locales/en/scrapers.json'
import projectDetailEn from '../../public/locales/en/projectDetail.json'

// Single source of truth for namespaces and their resources.
// Adding a new locale namespace only requires one entry here.
const namespaceResources = {
  common: commonEn,
  dashboard: dashboardEn,
  feedback: feedbackEn,
  feedbackDetail: feedbackDetailEn,
  chat: chatEn,
  login: loginEn,
  settings: settingsEn,
  projects: projectsEn,
  categories: categoriesEn,
  components: componentsEn,
  dataExplorer: dataExplorerEn,
  feedbackForms: feedbackFormsEn,
  prioritization: prioritizationEn,
  problemAnalysis: problemAnalysisEn,
  scrapers: scrapersEn,
  projectDetail: projectDetailEn,
} as const

void i18n.use(initReactI18next).init({
  lng: 'en',
  fallbackLng: 'en',
  defaultNS: 'common',
  ns: Object.keys(namespaceResources),
  resources: { en: namespaceResources },
  interpolation: { escapeValue: false },
  react: { useSuspense: false },
})

// Cleanup DOM and reset mock call history after each test.
// Clearing mocks prevents test order dependencies where assertions on
// call counts pick up calls made by previous tests.
afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

// Mock window.matchMedia for responsive components
Object.defineProperty(window, 'matchMedia', {
  writable: true,
  value: vi.fn().mockImplementation((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  })),
})

// Mock ResizeObserver for chart components
global.ResizeObserver = vi.fn().mockImplementation(() => ({
  observe: vi.fn(),
  unobserve: vi.fn(),
  disconnect: vi.fn(),
})) as unknown as typeof ResizeObserver

// Mock IntersectionObserver for lazy loading
global.IntersectionObserver = vi.fn().mockImplementation(() => ({
  observe: vi.fn(),
  unobserve: vi.fn(),
  disconnect: vi.fn(),
  root: null,
  rootMargin: '',
  thresholds: [],
})) as unknown as typeof IntersectionObserver

// Mock scrollTo for navigation tests
window.scrollTo = vi.fn()

// Mock URL.createObjectURL/revokeObjectURL for blob handling (not implemented in jsdom)
URL.createObjectURL = vi.fn().mockReturnValue('blob:mock-url')
URL.revokeObjectURL = vi.fn()

// Mock localStorage. getItem returns null for missing keys to match the
// real localStorage contract — important for libraries like Zustand's
// persist middleware which distinguishes null (no value) from undefined.
const localStorageMock = {
  getItem: vi.fn().mockReturnValue(null),
  setItem: vi.fn(),
  removeItem: vi.fn(),
  clear: vi.fn(),
}
Object.defineProperty(window, 'localStorage', { value: localStorageMock })

// Mock clipboard API. Tests can assert calls via navigator.clipboard.writeText.
Object.defineProperty(navigator, 'clipboard', {
  value: {
    writeText: vi.fn().mockResolvedValue(undefined),
    readText: vi.fn().mockResolvedValue(''),
  },
  writable: true,
  configurable: true,
})
