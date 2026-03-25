/**
 * @fileoverview Vitest setup file for all tests.
 * Configures global mocks and testing utilities.
 */
import '@testing-library/jest-dom'
import { vi, afterEach } from 'vitest'
import { cleanup } from '@testing-library/react'
import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'

// Initialize i18next for tests with inline English translations
// This avoids HTTP backend and provides real translated strings in tests.
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

i18n.use(initReactI18next).init({
  lng: 'en',
  fallbackLng: 'en',
  defaultNS: 'common',
  ns: ['common', 'dashboard', 'feedback', 'feedbackDetail', 'chat', 'login', 'settings', 'projects', 'categories', 'components', 'dataExplorer', 'feedbackForms', 'prioritization', 'problemAnalysis', 'scrapers', 'projectDetail'],
  resources: {
    en: {
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
    },
  },
  interpolation: { escapeValue: false },
  react: { useSuspense: false },
})

// Cleanup DOM after each test (critical for single jsdom)
afterEach(() => {
  cleanup()
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
}))

// Mock IntersectionObserver for lazy loading
global.IntersectionObserver = vi.fn().mockImplementation(() => ({
  observe: vi.fn(),
  unobserve: vi.fn(),
  disconnect: vi.fn(),
  root: null,
  rootMargin: '',
  thresholds: [],
}))

// Mock scrollTo for navigation tests
window.scrollTo = vi.fn()

// Mock localStorage
const localStorageMock = {
  getItem: vi.fn(),
  setItem: vi.fn(),
  removeItem: vi.fn(),
  clear: vi.fn(),
}
Object.defineProperty(window, 'localStorage', { value: localStorageMock })

// Mock clipboard API
const clipboardWriteText = vi.fn().mockResolvedValue(undefined)
const clipboardReadText = vi.fn().mockResolvedValue('')

Object.defineProperty(navigator, 'clipboard', {
  value: {
    writeText: clipboardWriteText,
    readText: clipboardReadText,
  },
  writable: true,
  configurable: true,
})

export { clipboardWriteText, clipboardReadText }
