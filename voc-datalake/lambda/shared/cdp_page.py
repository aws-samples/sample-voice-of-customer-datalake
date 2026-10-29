"""Chrome DevTools Protocol constants both managed-browser readers use (the design capture worker and the
Web Reviews plugin, which each drive an AgentCore browser session over CDP)."""
from typing import Final

#: ``Page.navigate``'s ``errorText`` for a main document answered with an HTTP error status. The page is still
#: read: a 403 bot wall says who blocked it.
HTTP_ERROR_RESPONSE: Final = 'net::ERR_HTTP_RESPONSE_CODE_FAILURE'
#: Evaluated while a page settles: ``[document.readyState, length of the visible text]`` as JSON.
PROGRESS_JS: Final = "JSON.stringify([document.readyState, document.body ? document.body.innerText.length : 0])"
