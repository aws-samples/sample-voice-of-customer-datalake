/**
 * Amplify configuration for AWS IAM request signing.
 * 
 * We use Amplify ONLY for:
 * - Credential exchange (JWT → AWS credentials via Identity Pool)
 * 
 * Request signing is handled separately by @aws-sdk/signature-v4 in streamApi.ts.
 * We keep existing amazon-cognito-identity-js for user authentication.
 */
import { Amplify } from 'aws-amplify'
import { getConfig } from '../config'

// eslint-disable-next-line no-restricted-syntax -- Singleton pattern requires mutation
let isConfigured = false

export function configureAmplify(): void {
  if (isConfigured) return

  const cfg = getConfig()
  
  if (!cfg.cognito.userPoolId || !cfg.cognito.clientId || !cfg.cognito.identityPoolId) {
    console.warn('Amplify configuration incomplete - streaming API will not work')
    return
  }

  Amplify.configure({
    Auth: {
      Cognito: {
        userPoolId: cfg.cognito.userPoolId,
        userPoolClientId: cfg.cognito.clientId,
        identityPoolId: cfg.cognito.identityPoolId,
        loginWith: {
          email: true,
        },
      }
    }
  }, { ssr: false })

  isConfigured = true
  console.log('Amplify configured for IAM signing')
}
