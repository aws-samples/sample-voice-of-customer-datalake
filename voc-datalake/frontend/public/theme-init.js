// Applies the persisted theme to <html> before first paint so the app never
// flashes the wrong theme. Loaded as an external file because the CloudFront
// CSP is `script-src 'self'` (no inline scripts).
//
// CONTRACT: storage key, persisted shape, theme ids and attribute names mirror
// src/theme/themeStore.ts and src/theme/themeCatalog.ts — pinned by
// src/theme/themeInit.test.ts.
(function () {
  const STORAGE_KEY = 'voc-theme'
  const PREFS = ['light', 'dark', 'system']
  // = COLOR_THEME_IDS / DEFAULT_COLOR_THEME / WORKSPACE_THEME_CHOICE in themeCatalog.ts.
  const THEME_IDS = ['kiro', 'nord', 'dracula', 'highcontrast', 'quick']
  const DEFAULT_THEME = 'kiro'
  const WORKSPACE = 'workspace'
  // Default for a visitor who never chose: dark (= DEFAULT_THEME_PREFERENCE).
  const DEFAULT_PREF = 'dark'
  let pref = DEFAULT_PREF
  let choice = WORKSPACE
  let workspaceTheme = DEFAULT_THEME
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    const state = raw ? JSON.parse(raw)?.state : null
    if (PREFS.includes(state?.preference)) pref = state.preference
    if (state?.colorTheme === WORKSPACE || THEME_IDS.includes(state?.colorTheme)) choice = state.colorTheme
    if (THEME_IDS.includes(state?.workspaceTheme)) workspaceTheme = state.workspaceTheme
  } catch {
    // Storage unavailable or corrupt: keep the defaults.
  }
  const prefersDark = window.matchMedia?.('(prefers-color-scheme: dark)').matches === true
  const systemMode = prefersDark ? 'dark' : 'light'
  const mode = pref === 'system' ? systemMode : pref
  const theme = choice === WORKSPACE ? workspaceTheme : choice
  const el = document.documentElement
  el.setAttribute('data-theme', theme + '-' + mode)
  el.setAttribute('data-color-theme', theme)
  el.setAttribute('data-mode', mode)
  el.setAttribute('data-mode-pref', pref)
  // = themeFavicon() in themeCatalog.ts: index.html's SVG icon link, before the tab first draws it.
  const icon = document.querySelector('link[rel="icon"]')
  if (icon) icon.setAttribute('href', theme === 'kiro' ? '/kiro-ghost.svg' : '/favicons/' + theme + '.svg')
})()
