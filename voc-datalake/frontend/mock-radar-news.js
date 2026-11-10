// Radar mock, a brand's news and releases (GET /radar/brands/{brand}/page `releases`, GET /radar/all):
// a mix of kinds over several months, dated and undated (`date_approximate`: the day first found),
// official and third-party, and a citation whose title the backend blanked (an index or listing
// page: the SPA shows its host and path). Used by mock-radar.js.

const daysAgo = (n) => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);

/** One news item of `brand`; `undated` = no published date, dated by the day the scan first found it. */
function newsItem(brand, { id, kind = 'release', via = ['web'], ago, feature, urls, titles, official = true, undated = false, mentions = 1 }) {
  return {
    release_id: id, brand: brand.key, brand_label: brand.label, feature, release_date: daysAgo(ago), date_approximate: undated,
    summary: `${brand.label}: ${feature.toLowerCase()}.`, urls, titles,
    source_kind: official ? 'official' : 'third_party', mentions,
    first_seen: `${daysAgo(ago)}T05:45:00Z`, last_seen: `${daysAgo(Math.max(ago - 3, 0))}T05:45:00Z`, kind, found_via: via,
  };
}

export function releases(brand) {
  const domain = brand.domains[0] ?? 'acme.example';
  const item = (spec) => newsItem(brand, spec);
  return {
    brand, days: 365, releases: [
      item({ id: 'r1', ago: 6, feature: 'Same-day delivery in five more cities', mentions: 3,
        urls: [`https://${domain}/news/same-day`, 'https://news.example.com/acme-same-day'],
        titles: ['Same-day delivery expands', 'Same-day delivery reaches five more cities'] }),
      item({ id: 'r3', kind: 'promotion', via: ['exa'], ago: 15, feature: 'Half-price first month on the premium plan',
        urls: [`https://${domain}/offers/premium`], titles: ['Premium plan offer'] }),
      // The backend blanked this title: the page is the brand's news index, not the article.
      item({ id: 'r6', ago: 24, feature: 'Gift cards in the app', undated: true,
        urls: [`https://${domain}/news/`], titles: [''] }),
      item({ id: 'r4', kind: 'partnership', via: ['feed'], ago: 33, feature: 'Partnership with Example Air for lounge deliveries',
        urls: [`https://${domain}/news/example-air`], titles: ['Working with Example Air'] }),
      item({ id: 'r5', kind: 'announcement', via: ['web', 'exa'], ago: 41, feature: 'Opening a second warehouse', official: false,
        urls: ['https://news.example.com/acme-warehouse'], titles: ['A second warehouse opens'] }),
      item({ id: 'r2', kind: 'news', ago: 58, feature: 'Loyalty points on subscriptions', undated: true, official: false,
        urls: ['https://reviews.example.org/acme-loyalty'], titles: ['Loyalty points on subscriptions, reviewed'] }),
      item({ id: 'r7', ago: 77, feature: 'Order tracking on the map',
        urls: [`https://${domain}/changelog/2026-tracking`], titles: ['Live tracking'] }),
      item({ id: 'r8', kind: 'promotion', ago: 96, feature: 'Free returns for members', official: false,
        urls: ['https://deals.example.net/acme-returns'], titles: [''] }),
      item({ id: 'r9', ago: 130, feature: 'Dark mode in the app',
        urls: [`https://${domain}/changelog/dark-mode`], titles: ['Dark mode'] }),
    ],
  };
}
