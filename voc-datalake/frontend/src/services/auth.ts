/**
 * @fileoverview AWS Cognito authentication service.
 * 
 * Provides authentication operations using Amazon Cognito User Pools:
 * - Sign in with username/password
 * - Token refresh with automatic expiration handling
 * - Password reset flow (forgot password + confirmation)
 * - New password challenge handling (first login)
 * 
 * Security features:
 * - Tokens stored in sessionStorage via authStore
 * - Automatic token refresh 5 minutes before expiration
 * - Graceful handling of expired sessions
 * 
 * @module services/auth
 */

import {
  CognitoUserPool,
  CognitoUser,
  AuthenticationDetails,
  CognitoUserSession,
  CognitoRefreshToken,
} from 'amazon-cognito-identity-js'
import { config } from '../config'
import { useAuthStore } from '../store/authStore'
import type { User } from '../store/authStore'

// Type guards for JWT payload validation
function isString(value: unknown): value is string {
  return typeof value === 'string'
}

function isNumber(value: unknown): value is number {
  return typeof value === 'number'
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string')
}

/**
 * Gets the Cognito User Pool instance.
 * @returns CognitoUserPool instance or null if not configured
 */
const getUserPool = (): CognitoUserPool | null => {
  if (!config.cognito.userPoolId || !config.cognito.clientId) {
    return null
  }
  return new CognitoUserPool({
    UserPoolId: config.cognito.userPoolId,
    ClientId: config.cognito.clientId,
  })
}

// Type guard for Record<string, unknown>
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Parses a JWT token to extract its payload.
 * @param token - The JWT token string
 * @returns Decoded payload object or empty object on error
 */
const parseJwt = (token: string): Record<string, unknown> => {
  try {
    const base64Url = token.split('.')[1]
    const base64 = base64Url.replace(/-/g, '+').replace(/_/g, '/')
    const jsonPayload = decodeURIComponent(
      atob(base64)
        .split('')
        .map((c) => '%' + ('00' + c.charCodeAt(0).toString(16)).slice(-2))
        .join('')
    )
    const parsed: unknown = JSON.parse(jsonPayload)
    if (isRecord(parsed)) {
      return parsed
    }
    return {}
  } catch {
    return {}
  }
}

/**
 * Extracts user information from a Cognito ID token.
 * @param idToken - The JWT ID token from Cognito
 * @returns User object with username, email, name, and groups
 */
const extractUser = (idToken: string): User => {
  const payload = parseJwt(idToken)
  const username = payload['cognito:username']
  const email = payload['email']
  const name = payload['name']
  const groups = payload['cognito:groups']
  
  return {
    username: isString(username) ? username : '',
    email: isString(email) ? email : '',
    name: isString(name) ? name : undefined,
    groups: isStringArray(groups) ? groups : [],
  }
}

/**
 * Authentication service for AWS Cognito operations.
 */
export const authService = {
  /**
   * Checks if Cognito is properly configured with User Pool ID and Client ID.
   * @returns true if Cognito environment variables are set
   */
  isConfigured: (): boolean => {
    return !!(config.cognito.userPoolId && config.cognito.clientId)
  },

  /**
   * Authenticates a user with username and password.
   * On success, stores tokens in authStore and returns the session.
   * 
   * @param username - Cognito username or email
   * @param password - User's password
   * @returns Promise resolving to CognitoUserSession
   * @throws Error with code 'NewPasswordRequired' if password change needed
   * @throws Error if authentication fails
   */
  signIn: (username: string, password: string): Promise<CognitoUserSession> => {
    return new Promise((resolve, reject) => {
      const userPool = getUserPool()
      if (!userPool) {
        reject(new Error('Cognito not configured'))
        return
      }

      const cognitoUser = new CognitoUser({
        Username: username,
        Pool: userPool,
      })

      const authDetails = new AuthenticationDetails({
        Username: username,
        Password: password,
      })

      cognitoUser.authenticateUser(authDetails, {
        onSuccess: (session) => {
          const idToken = session.getIdToken().getJwtToken()
          const accessToken = session.getAccessToken().getJwtToken()
          const refreshToken = session.getRefreshToken().getToken()

          const user = extractUser(idToken)
          
          useAuthStore.getState().setTokens({ accessToken, idToken, refreshToken })
          useAuthStore.getState().setUser(user)
          
          resolve(session)
        },
        onFailure: (err) => {
          reject(err)
        },
        newPasswordRequired: (userAttributes: Record<string, unknown>) => {
          // Handle new password required (first login)
          reject({ 
            code: 'NewPasswordRequired', 
            message: 'New password required',
            userAttributes,
            cognitoUser,
          })
        },
      })
    })
  },

  /**
   * Completes the new password challenge for first-time login.
   * 
   * @param cognitoUser - CognitoUser instance from signIn rejection
   * @param newPassword - The new password to set
   * @returns Promise resolving to CognitoUserSession
   * @throws Error if password change fails
   */
  completeNewPassword: (
    cognitoUser: CognitoUser,
    newPassword: string
  ): Promise<CognitoUserSession> => {
    return new Promise((resolve, reject) => {
      cognitoUser.completeNewPasswordChallenge(newPassword, {}, {
        onSuccess: (session) => {
          const idToken = session.getIdToken().getJwtToken()
          const accessToken = session.getAccessToken().getJwtToken()
          const refreshToken = session.getRefreshToken().getToken()

          const user = extractUser(idToken)
          
          useAuthStore.getState().setTokens({ accessToken, idToken, refreshToken })
          useAuthStore.getState().setUser(user)
          
          resolve(session)
        },
        onFailure: (err) => {
          reject(err)
        },
      })
    })
  },

  /**
   * Signs out the current user and clears all stored tokens.
   */
  signOut: (): void => {
    const userPool = getUserPool()
    if (userPool) {
      const cognitoUser = userPool.getCurrentUser()
      if (cognitoUser) {
        cognitoUser.signOut()
      }
    }
    useAuthStore.getState().logout()
  },

  /**
   * Refreshes the current session using the stored refresh token.
   * Updates all tokens in authStore on success.
   * 
   * @returns Promise resolving to new CognitoUserSession
   * @throws Error if refresh fails (triggers logout)
   */
  refreshSession: (): Promise<CognitoUserSession> => {
    return new Promise((resolve, reject) => {
      const userPool = getUserPool()
      if (!userPool) {
        reject(new Error('Cognito not configured'))
        return
      }

      const cognitoUser = userPool.getCurrentUser()
      if (!cognitoUser) {
        reject(new Error('No current user'))
        return
      }

      const refreshToken = useAuthStore.getState().refreshToken
      if (!refreshToken) {
        reject(new Error('No refresh token'))
        return
      }

      cognitoUser.refreshSession(
        new CognitoRefreshToken({ RefreshToken: refreshToken }),
        (err: Error | null, session: CognitoUserSession | null) => {
          if (err || !session) {
            useAuthStore.getState().logout()
            reject(err ?? new Error('Session refresh failed'))
            return
          }

          const idToken = session.getIdToken().getJwtToken()
          const accessToken = session.getAccessToken().getJwtToken()
          const newRefreshToken = session.getRefreshToken().getToken()

          const user = extractUser(idToken)
          
          useAuthStore.getState().setTokens({ 
            accessToken, 
            idToken, 
            refreshToken: newRefreshToken 
          })
          useAuthStore.getState().setUser(user)
          
          resolve(session)
        }
      )
    })
  },

  /**
   * Gets a valid access token, automatically refreshing if expiring soon.
   * Refreshes if token expires within 5 minutes.
   * 
   * @returns Promise resolving to access token string or null if unavailable
   */
  getAccessToken: async (): Promise<string | null> => {
    const { accessToken, idToken } = useAuthStore.getState()
    
    if (!accessToken || !idToken) {
      return null
    }

    // Check if token is expired (with 5 min buffer)
    const payload = parseJwt(accessToken)
    const exp = payload.exp
    if (!isNumber(exp)) {
      return accessToken
    }
    
    const expMs = exp * 1000
    const now = Date.now()
    
    if (expMs - now < 5 * 60 * 1000) {
      try {
        const session = await authService.refreshSession()
        return session.getAccessToken().getJwtToken()
      } catch {
        return null
      }
    }

    return accessToken
  },

  /**
   * Gets the current ID token from the auth store.
   * @returns ID token string or null if not authenticated
   */
  getIdToken: (): string | null => {
    return useAuthStore.getState().idToken
  },

  /**
   * Initiates the forgot password flow, sending a verification code to the user's email.
   * 
   * @param username - Cognito username or email
   * @returns Promise resolving when code is sent
   * @throws Error if request fails
   */
  forgotPassword: (username: string): Promise<void> => {
    return new Promise((resolve, reject) => {
      const userPool = getUserPool()
      if (!userPool) {
        reject(new Error('Cognito not configured'))
        return
      }

      const cognitoUser = new CognitoUser({
        Username: username,
        Pool: userPool,
      })

      cognitoUser.forgotPassword({
        onSuccess: () => resolve(),
        onFailure: (err) => reject(err),
      })
    })
  },

  /**
   * Confirms a password reset using the verification code.
   * 
   * @param username - Cognito username or email
   * @param code - Verification code from email
   * @param newPassword - New password to set
   * @returns Promise resolving when password is reset
   * @throws Error if confirmation fails
   */
  confirmPassword: (
    username: string,
    code: string,
    newPassword: string
  ): Promise<void> => {
    return new Promise((resolve, reject) => {
      const userPool = getUserPool()
      if (!userPool) {
        reject(new Error('Cognito not configured'))
        return
      }

      const cognitoUser = new CognitoUser({
        Username: username,
        Pool: userPool,
      })

      cognitoUser.confirmPassword(code, newPassword, {
        onSuccess: () => resolve(),
        onFailure: (err) => reject(err),
      })
    })
  },

  /**
   * Changes the current user's password.
   *
   * @param oldPassword - Current password
   * @param newPassword - New password to set
   * @returns Promise resolving when password is changed
   * @throws Error if change fails (e.g., incorrect current password)
   */
  changePassword: (oldPassword: string, newPassword: string): Promise<void> => {
    return new Promise((resolve, reject) => {
      const userPool = getUserPool()
      if (!userPool) {
        reject(new Error('Cognito not configured'))
        return
      }

      const cognitoUser = userPool.getCurrentUser()
      if (!cognitoUser) {
        reject(new Error('No current user'))
        return
      }

      // Need to get session first
      cognitoUser.getSession(
        (err: Error | null, session: CognitoUserSession | null) => {
          if (err || !session) {
            reject(err ?? new Error('No session'))
            return
          }

          cognitoUser.changePassword(oldPassword, newPassword, (changeErr) => {
            if (changeErr) {
              reject(changeErr)
              return
            }
            resolve()
          })
        }
      )
    })
  },
}
