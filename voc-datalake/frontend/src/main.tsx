import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import './i18n/config'
import './index.css'
import { ConfigError } from './lib/errors'

const rootElement = document.getElementById('root')
if (!rootElement) {
  throw new ConfigError('Root element not found')
}

createRoot(rootElement).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
