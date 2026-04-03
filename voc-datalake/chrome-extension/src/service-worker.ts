import { submitReviews } from './api'
import { getTokens } from './storage'

const CONTEXT_MENU_ID = 'voc-send-reviews'

// Create context menu on install
chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: CONTEXT_MENU_ID,
    title: 'Send to VoC Data Lake',
    contexts: ['selection'],
  })
})

// Handle context menu click
chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId !== CONTEXT_MENU_ID) return
  if (!info.selectionText || !tab?.id) return

  const tabId = tab.id
  const selectedText = info.selectionText.trim()
  if (!selectedText) return

  console.log('[VoC] Context menu clicked, selected text length:', selectedText.length)

  const tokens = await getTokens()
  if (!tokens) {
    console.log('[VoC] No auth tokens found')
    await sendToast(tabId, 'error', 'Not signed in', 'Open the VoC extension and sign in first.')
    return
  }

  console.log('[VoC] Authenticated, sending to API...')

  // Show loading toast immediately
  await sendToast(tabId, 'loading', 'Sending to VoC Data Lake', 'Processing your selection...')

  try {
    const result = await submitReviews({
      source_url: tab.url ?? '',
      page_title: tab.title ?? '',
      raw_text: selectedText,
    })

    console.log('[VoC] API response:', JSON.stringify(result))

    if (result.success) {
      const count = result.imported_count
      await sendToast(
        tabId,
        'success',
        'Sent to VoC Data Lake',
        `${count} review${count !== 1 ? 's' : ''} queued for processing.`,
      )
    } else {
      await sendToast(tabId, 'error', 'Submission failed', 'Something went wrong. Try again.')
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error'
    console.error('[VoC] API error:', message)
    await sendToast(tabId, 'error', 'Error', message)
  }
})

// Handle messages from popup
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type === 'GET_AUTH_STATUS') {
    getTokens().then((tokens) => {
      sendResponse({
        type: 'AUTH_STATUS',
        data: {
          authenticated: !!tokens,
          username: tokens?.username,
        },
      })
    })
    return true // async response
  }
  return false
})

/**
 * Ensure the content script is injected into the tab.
 * Needed for tabs that were open before the extension was installed/reloaded.
 */
async function ensureContentScript(tabId: number): Promise<void> {
  try {
    // Try sending a ping — if content script is loaded, it'll respond
    await chrome.tabs.sendMessage(tabId, { type: 'PING' })
  } catch {
    // Content script not loaded — inject it
    try {
      await chrome.scripting.executeScript({
        target: { tabId },
        files: ['dist/content.js'],
      })
    } catch (injectErr) {
      console.warn('[VoC] Cannot inject content script:', injectErr)
    }
  }
}

/** Send a toast notification to the content script on the active tab */
async function sendToast(
  tabId: number,
  variant: 'loading' | 'success' | 'error',
  title: string,
  body: string,
): Promise<void> {
  // Make sure content script is available
  await ensureContentScript(tabId)

  try {
    await chrome.tabs.sendMessage(tabId, {
      type: 'SHOW_TOAST',
      variant,
      title,
      body,
    })
  } catch {
    // Still can't reach content script — fall back to badge
    console.warn('[VoC] Toast fallback to badge:', title, body)
    const text = variant === 'success' ? '✓' : variant === 'error' ? '✗' : '...'
    const color = variant === 'success' ? '#22c55e' : variant === 'error' ? '#ef4444' : '#3b82f6'
    chrome.action.setBadgeText({ text })
    chrome.action.setBadgeBackgroundColor({ color })
    chrome.action.setTitle({ title: `${title}: ${body}` })

    if (variant !== 'loading') {
      setTimeout(() => {
        chrome.action.setBadgeText({ text: '' })
        chrome.action.setTitle({ title: 'VoC Data Lake - Review Collector' })
      }, 3000)
    }
  }
}
