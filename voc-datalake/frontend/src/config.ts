// Type-safe environment variable access
function getEnvString(key: string, defaultValue: string = ''): string {
  const value: unknown = import.meta.env[key]
  return typeof value === 'string' ? value : defaultValue
}

// Runtime configuration from environment variables
export const config = {
  apiEndpoint: getEnvString('VITE_API_ENDPOINT'),
  artifactBuilderEndpoint: getEnvString('VITE_ARTIFACT_BUILDER_ENDPOINT'),
  cognito: {
    userPoolId: getEnvString('VITE_COGNITO_USER_POOL_ID'),
    clientId: getEnvString('VITE_COGNITO_CLIENT_ID'),
    region: getEnvString('VITE_COGNITO_REGION', 'us-east-1'),
  },
}
