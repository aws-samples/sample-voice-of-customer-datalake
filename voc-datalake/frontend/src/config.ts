// Runtime configuration from environment variables
export const config = {
  apiEndpoint: import.meta.env.VITE_API_ENDPOINT || '',
  artifactBuilderEndpoint: import.meta.env.VITE_ARTIFACT_BUILDER_ENDPOINT || '',
  cognito: {
    userPoolId: import.meta.env.VITE_COGNITO_USER_POOL_ID || '',
    clientId: import.meta.env.VITE_COGNITO_CLIENT_ID || '',
    region: import.meta.env.VITE_COGNITO_REGION || 'us-east-1',
  },
};
