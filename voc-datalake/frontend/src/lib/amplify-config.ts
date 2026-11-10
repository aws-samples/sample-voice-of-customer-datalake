/**
 * Amplify v6 configuration for signing in to the app user pool (services/auth.ts).
 *
 * Only the user pool is configured. No identity pool: nothing in the SPA uses AWS credentials
 * (every API call carries the Cognito ID token), so a session never calls Cognito Identity.
 * The board pool (feedback boards, review links) is NOT Amplify's: services/boardAuth.ts keeps it
 * apart, since Amplify holds one user pool per page.
 */
import { Amplify } from 'aws-amplify'
import { getRealtimeEndpoints, getRuntimeConfig } from '../runtimeConfig'

/** Process-wide flag: Amplify is configured once per page load. */
const amplifyState = { configured: false }

export function configureAmplify(): void {
  if (amplifyState.configured) return

  const cfg = getRuntimeConfig()

  if (cfg.cognito.userPoolId === '' || cfg.cognito.clientId === '') {
    console.warn('Cognito not configured - sign-in is unavailable')
    return
  }

  // Push notifications (docs/realtime.md): only on a deployment with an Event API.
  const realtime = getRealtimeEndpoints()
  Amplify.configure({
    ...(realtime === null ? {} : {
      API: {
        Events: {
          endpoint: `https://${realtime.httpDns}/event`,
          region: cfg.cognito.region,
          defaultAuthMode: 'userPool',
        },
      },
    }),
    Auth: {
      Cognito: {
        userPoolId: cfg.cognito.userPoolId,
        userPoolClientId: cfg.cognito.clientId,
        loginWith: {
          email: true,
        },
      },
    },
  }, { ssr: false })

  amplifyState.configured = true
}
