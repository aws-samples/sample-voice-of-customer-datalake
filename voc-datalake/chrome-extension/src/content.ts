/**
 * Content script — injected into all pages.
 * Shows toast notifications when reviews are sent via the context menu.
 */

// Listen for messages from the service worker
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type === 'PING') {
    sendResponse({ type: 'PONG' })
    return false
  }

  if (message.type === 'GET_PAGE_INFO') {
    sendResponse({ url: window.location.href, title: document.title })
  }

  if (message.type === 'SHOW_TOAST') {
    showToast(message.variant, message.title, message.body)
  }

  return false
})

type ToastVariant = 'loading' | 'success' | 'error'

let currentToast: HTMLDivElement | null = null

function showToast(variant: ToastVariant, title: string, body: string): void {
  // Remove existing toast
  if (currentToast) {
    currentToast.remove()
    currentToast = null
  }

  const toast = document.createElement('div')
  currentToast = toast

  const icon = variant === 'loading' ? '⏳' : variant === 'success' ? '✅' : '❌'
  const borderColor = variant === 'loading' ? '#3b82f6' : variant === 'success' ? '#10b981' : '#ef4444'

  toast.setAttribute('style', [
    'position: fixed',
    'bottom: 24px',
    'right: 24px',
    'z-index: 2147483647',
    'background: #ffffff',
    'border-radius: 10px',
    `border-left: 4px solid ${borderColor}`,
    'box-shadow: 0 8px 24px rgba(0,0,0,0.15)',
    'padding: 14px 18px',
    'max-width: 340px',
    'font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
    'font-size: 13px',
    'color: #1f2937',
    'line-height: 1.4',
    'transition: opacity 0.3s, transform 0.3s',
    'opacity: 0',
    'transform: translateY(10px)',
  ].join(';'))

  toast.innerHTML = `
    <div style="display:flex;align-items:flex-start;gap:10px;">
      <span style="font-size:18px;line-height:1;flex-shrink:0;">${icon}</span>
      <div>
        <div style="font-weight:600;margin-bottom:2px;">${escapeHtml(title)}</div>
        <div style="color:#6b7280;">${escapeHtml(body)}</div>
      </div>
    </div>
  `

  document.body.appendChild(toast)

  // Animate in
  requestAnimationFrame(() => {
    toast.style.opacity = '1'
    toast.style.transform = 'translateY(0)'
  })

  // Auto-dismiss success/error after 4 seconds
  if (variant !== 'loading') {
    setTimeout(() => {
      toast.style.opacity = '0'
      toast.style.transform = 'translateY(10px)'
      setTimeout(() => {
        toast.remove()
        if (currentToast === toast) currentToast = null
      }, 300)
    }, 4000)
  }
}

function escapeHtml(text: string): string {
  const div = document.createElement('div')
  div.textContent = text
  return div.innerHTML
}
