/**
 * Amplify configuration for AWS credential exchange.
 *
 * We use Amplify ONLY for:
 * - Credential exchange (JWT → AWS credentials via Identity Pool)
 *
 * We keep existing amazon-cognito-identity-js for user authentication.
 * Streaming chat now uses Cognito token auth via API Gateway (streamClient.ts).
 */
import { Amplify } from 'aws-amplify'
import { getRuntimeConfig } from '../runtimeConfig'

// eslint-disable-next-line no-restricted-syntax -- Singleton pattern requires mutation
let isConfigured = false

export function configureAmplify(): void {
  if (isConfigured) return

  const cfg = getRuntimeConfig()

  if (cfg.cognito.userPoolId === '' || cfg.cognito.clientId === '' || cfg.cognito.identityPoolId === '') {
    console.warn('Amplify configuration incomplete - streaming API will not work')
    return
  }

  Amplify.configure({
    Auth: {
      Cognito: {
        userPoolId: cfg.cognito.userPoolId,
        userPoolClientId: cfg.cognito.clientId,
        identityPoolId: cfg.cognito.identityPoolId,
        loginWith: { email: true },
      },
    },
  }, { ssr: false })

  isConfigured = true
  console.log('Amplify configured for IAM signing')
}
