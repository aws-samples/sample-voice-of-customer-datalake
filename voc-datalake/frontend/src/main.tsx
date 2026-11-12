import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import './i18n/config'
import './index.css'
import { ConfigError } from './lib/errors'
import { installStaleBuildReload } from './lib/staleBuildReload'
// Another tab's sign-out or expired session ends this tab's too (its listener installs on import).
import './services/crossTabSignOut'

// A tab opened before a deploy reloads once when it asks for a chunk the deploy removed (lib/staleBuildReload).
installStaleBuildReload({
  target: window, storage: window.sessionStorage, reload: () => window.location.reload(),
  build: import.meta.env.BUILD_COMMIT, isOnline: () => window.navigator.onLine,
})

const rootElement = document.getElementById('root')
if (!rootElement) {
  throw new ConfigError('Root element not found')
}

createRoot(rootElement).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
