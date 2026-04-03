/** Configuration stored in chrome.storage.local */
export interface ExtensionConfig {
  apiEndpoint: string
  cognitoUserPoolId: string
  cognitoClientId: string
  cognitoRegion: string
}

/** Auth tokens stored in chrome.storage.session */
export interface AuthTokens {
  idToken: string
  accessToken: string
  refreshToken: string
  username: string
  expiresAt: number
}

/** Review item sent to the backend */
export interface ReviewItem {
  text: string
  id?: string
  rating?: number | null
  author?: string | null
  title?: string | null
  date?: string | null
}

/** Payload sent to POST /extension/reviews */
export interface ReviewSubmission {
  source_url: string
  page_title: string
  raw_text?: string
  items?: ReviewItem[]
}

/** Response from POST /extension/reviews */
export interface SubmitResponse {
  success: boolean
  batch_id: string
  imported_count: number
  total_items: number
  s3_uri?: string | null
  errors?: string[]
}

/** Response from GET /extension/status */
export interface StatusResponse {
  success: boolean
  user_id: string
  configured: boolean
}

/** Messages between content script, popup, and service worker */
export type ExtensionMessage =
  | { type: 'SEND_SELECTION'; data: { text: string; url: string; title: string } }
  | { type: 'SUBMIT_RESULT'; data: SubmitResponse }
  | { type: 'SUBMIT_ERROR'; error: string }
  | { type: 'GET_AUTH_STATUS' }
  | { type: 'AUTH_STATUS'; data: { authenticated: boolean; username?: string } }
