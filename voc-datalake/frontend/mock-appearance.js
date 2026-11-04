// Appearance mock: GET|PUT /settings/appearance in the lambda/shared/appearance_routes.py
// wire shape. GET answers {default_theme}; PUT {default_theme} answers
// {success: true, settings: {default_theme}}, or 400 {success: false, error} for an id
// the platform does not ship. Stateful for the life of the mock process. The mock caller
// is an admin, so the real route's 403 for everyone else is not reproduced here.
// Start with MOCK_DEFAULT_THEME=<id> to open on another workspace theme.
// Wired into mock-server.js by handleDomainModules.

const ROUTE = '/settings/appearance';
// THEME_IDS in lambda/shared/appearance.py (= COLOR_THEME_IDS in src/theme/themeCatalog.ts).
const THEME_IDS = ['kiro', 'nord', 'dracula', 'highcontrast', 'quick'];

const appearance = {
  default_theme: THEME_IDS.includes(process.env.MOCK_DEFAULT_THEME) ? process.env.MOCK_DEFAULT_THEME : 'kiro',
};

function refusal(body) {
  const theme = body && typeof body === 'object' ? body.default_theme : undefined;
  return THEME_IDS.includes(theme) ? null : `default_theme must be one of: ${THEME_IDS.join(', ')}`;
}

/** Handle `/settings/appearance`; returns true when the request was taken. */
export function handleAppearanceRoutes(req, res, url, send, shared) {
  if (url.pathname !== ROUTE) return false;
  if (req.method === 'GET') {
    send(200, { ...appearance });
    return true;
  }
  if (req.method !== 'PUT') {
    send(405, { success: false, error: 'Method not allowed' });
    return true;
  }
  shared.collectJson(req, res, (body) => {
    const refused = refusal(body);
    if (refused) {
      send(400, { success: false, error: refused });
      return;
    }
    appearance.default_theme = body.default_theme;
    send(200, { success: true, settings: { ...appearance } });
  });
  return true;
}
