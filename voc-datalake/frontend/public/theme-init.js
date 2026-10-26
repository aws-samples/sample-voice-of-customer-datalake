// Applies the persisted theme to <html> before first paint so the app never
// flashes the wrong theme. Loaded as an external file because the CloudFront
// CSP is `script-src 'self'` (no inline scripts).
//
// CONTRACT: storage key, persisted shape and attribute names mirror
// src/theme/themeStore.ts — pinned by src/theme/themeInit.test.ts.
(function () {
  const STORAGE_KEY = 'voc-theme'
  const PREFS = ['light', 'dark', 'system']
  // Default for a visitor who never chose: Kiro Dark (= DEFAULT_THEME_PREFERENCE).
  const DEFAULT_PREF = 'dark'
  let pref = DEFAULT_PREF
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    const stored = raw ? JSON.parse(raw)?.state?.preference : null
    if (PREFS.includes(stored)) pref = stored
  } catch {
    // Storage unavailable or corrupt: keep the default.
  }
  const prefersDark = window.matchMedia?.('(prefers-color-scheme: dark)').matches === true
  const systemMode = prefersDark ? 'dark' : 'light'
  const mode = pref === 'system' ? systemMode : pref
  const el = document.documentElement
  el.setAttribute('data-theme', 'kiro-' + mode)
  el.setAttribute('data-mode', mode)
  el.setAttribute('data-mode-pref', pref)
})()
