/**
 * @fileoverview Vitest setup file for all tests.
 * Configures global mocks and testing utilities.
 */
import '@testing-library/jest-dom'
import { vi, afterEach } from 'vitest'
import { cleanup } from '@testing-library/react'

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
