import { getConfig, saveConfig, getTokens, saveTokens, clearTokens } from './storage'
import type { ExtensionConfig, AuthTokens } from './types'

// DOM elements
const configSection = document.getElementById('config-section') as HTMLDivElement
const loginSection = document.getElementById('login-section') as HTMLDivElement
const authSection = document.getElementById('auth-section') as HTMLDivElement

const deploymentUrlInput = document.getElementById('deployment-url') as HTMLInputElement
const saveConfigBtn = document.getElementById('save-config-btn') as HTMLButtonElement
const configError = document.getElementById('config-error') as HTMLDivElement
const configErrorText = document.getElementById('config-error-text') as HTMLSpanElement
const configLoading = document.getElementById('config-loading') as HTMLDivElement

const usernameInput = document.getElementById('username') as HTMLInputElement
const passwordInput = document.getElementById('password') as HTMLInputElement
const loginBtn = document.getElementById('login-btn') as HTMLButtonElement
const loginError = document.getElementById('login-error') as HTMLDivElement
const loginErrorText = document.getElementById('login-error-text') as HTMLSpanElement
const reconfigureBtn = document.getElementById('reconfigure-btn') as HTMLButtonElement

const usernameDisplay = document.getElementById('username-display') as HTMLElement
const logoutBtn = document.getElementById('logout-btn') as HTMLButtonElement
const reconfigBtn = document.getElementById('reconfig-btn') as HTMLButtonElement

function showSection(section: 'config' | 'login' | 'auth'): void {
  configSection.classList.toggle('hidden', section !== 'config')
  loginSection.classList.toggle('hidden', section !== 'login')
  authSection.classList.toggle('hidden', section !== 'auth')
}

async function initialize(): Promise<void> {
  const config = await getConfig()
  if (!config) {
    showSection('config')
    return
  }

  const tokens = await getTokens()
  if (!tokens || tokens.expiresAt < Date.now()) {
    showSection('login')
    return
  }

  usernameDisplay.textContent = tokens.username
  showSection('auth')
}

// Connect — fetch config.json from deployment URL
saveConfigBtn.addEventListener('click', async () => {
  let url = deploymentUrlInput.value.trim()
  if (!url) return

  // Normalize URL
  if (!url.startsWith('http')) url = `https://${url}`
  url = url.replace(/\/+$/, '')

  saveConfigBtn.disabled = true
  configError.classList.add('hidden')
  configLoading.classList.remove('hidden')

  try {
    const configUrl = `${url}/config.json`
    const response = await fetch(configUrl)

    if (!response.ok) {
      throw new Error(`Could not fetch config (${response.status}). Make sure the URL is correct.`)
    }

    const data: unknown = await response.json()

    if (!isValidRemoteConfig(data)) {
      throw new Error('Invalid config.json — missing apiEndpoint or cognito settings')
    }

    const config: ExtensionConfig = {
      apiEndpoint: data.apiEndpoint,
      cognitoUserPoolId: data.cognito.userPoolId,
      cognitoClientId: data.cognito.clientId,
      cognitoRegion: data.cognito.region || 'us-east-1',
    }

    if (!config.apiEndpoint || !config.cognitoUserPoolId || !config.cognitoClientId) {
      throw new Error('Config is incomplete — API endpoint or Cognito settings are empty')
    }

    await saveConfig(config)
    showSection('login')
  } catch (err) {
    configError.classList.remove('hidden')
    configErrorText.textContent = err instanceof Error ? err.message : 'Failed to fetch config'
  } finally {
    saveConfigBtn.disabled = false
    configLoading.classList.add('hidden')
  }
})

/** Type guard for the remote config.json shape */
function isValidRemoteConfig(data: unknown): data is {
  apiEndpoint: string
  cognito: { userPoolId: string; clientId: string; region: string }
} {
  if (typeof data !== 'object' || data === null) return false
  const obj = data as Record<string, unknown>
  if (typeof obj.apiEndpoint !== 'string') return false
  if (typeof obj.cognito !== 'object' || obj.cognito === null) return false
  const cognito = obj.cognito as Record<string, unknown>
  return typeof cognito.userPoolId === 'string' && typeof cognito.clientId === 'string'
}

// Sign in with Cognito
loginBtn.addEventListener('click', async () => {
  const username = usernameInput.value.trim()
  const password = passwordInput.value

  if (!username || !password) return

  loginBtn.disabled = true
  loginBtn.textContent = 'Signing in...'
  loginError.classList.add('hidden')

  try {
    const config = await getConfig()
    if (!config) throw new Error('Not configured')

    const tokens = await authenticateWithCognito(config, username, password)
    await saveTokens(tokens)

    usernameDisplay.textContent = tokens.username
    showSection('auth')
  } catch (err) {
    loginError.classList.remove('hidden')
    loginErrorText.textContent = err instanceof Error ? err.message : 'Sign in failed'
  } finally {
    loginBtn.disabled = false
    loginBtn.textContent = 'Sign In'
  }
})

// Sign out
logoutBtn.addEventListener('click', async () => {
  await clearTokens()
  showSection('login')
})

// Reconfigure
reconfigureBtn.addEventListener('click', () => showSection('config'))
reconfigBtn.addEventListener('click', () => showSection('config'))

/**
 * Authenticate with Cognito using USER_PASSWORD_AUTH flow.
 * Calls the Cognito API directly via HTTPS — no SDK needed.
 */
async function authenticateWithCognito(
  config: ExtensionConfig,
  username: string,
  password: string,
): Promise<AuthTokens> {
  const endpoint = `https://cognito-idp.${config.cognitoRegion}.amazonaws.com/`

  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-amz-json-1.1',
      'X-Amz-Target': 'AWSCognitoIdentityProviderService.InitiateAuth',
    },
    body: JSON.stringify({
      AuthFlow: 'USER_PASSWORD_AUTH',
      ClientId: config.cognitoClientId,
      AuthParameters: {
        USERNAME: username,
        PASSWORD: password,
      },
    }),
  })

  if (!response.ok) {
    const body = await response.json().catch(() => ({}))
    const errorMessage =
      typeof body === 'object' && body !== null && 'message' in body
        ? String((body as Record<string, unknown>).message)
        : 'Authentication failed'
    throw new Error(errorMessage)
  }

  const data: unknown = await response.json()
  if (typeof data !== 'object' || data === null || !('AuthenticationResult' in data)) {
    throw new Error('Unexpected auth response')
  }

  const authResult = (data as Record<string, unknown>).AuthenticationResult
  if (
    typeof authResult !== 'object' ||
    authResult === null ||
    !('IdToken' in authResult) ||
    !('AccessToken' in authResult) ||
    !('RefreshToken' in authResult) ||
    !('ExpiresIn' in authResult)
  ) {
    throw new Error('Missing tokens in auth response')
  }

  const result = authResult as Record<string, unknown>

  return {
    idToken: String(result.IdToken),
    accessToken: String(result.AccessToken),
    refreshToken: String(result.RefreshToken),
    username,
    expiresAt: Date.now() + Number(result.ExpiresIn) * 1000,
  }
}

// Initialize on popup open
initialize()
