"""Bounds on the stored web scraper list (``webscraper_configs`` in the shared API-credentials secret).

Two admin routes write that value: ``POST /scrapers`` (one scraper at a time) and
``PUT /integrations/webscraper/credentials`` (the whole list). Both apply these bounds, so a typo
or a runaway client cannot lock integration credentials out of the secret, and the URL policy
(``shared.url_policy.scraper_url_error``, one DNS check per URL) runs over a bounded list.
"""
from typing import Final

MAX_SCRAPERS: Final = 50
# The whole `webscraper_configs` value. Secrets Manager caps the secret at 64 KiB
# (`SECRET_STRING_MAX_BYTES`) and integration credentials share it, so scrapers alone may not fill
# it: otherwise scraper configs could lock integration credentials out of the secret.
MAX_WEBSCRAPER_CONFIGS_BYTES: Final = 48 * 1024
MAX_URLS_PER_SCRAPER: Final = 25
INVALID_CONFIGS: Final = 'configs must be a JSON array of scraper configurations'


def scraper_list_error(raw: str, configs: object) -> str | None:
    """Why a whole ``webscraper_configs`` value (``raw``, parsed as ``configs``) must not be stored, else None.

    The list bounds only. ``POST /scrapers`` also checks each scraper's own shape (its id pattern,
    8 KiB per scraper, field lengths) because it stores one edited scraper; for the whole list the
    48 KiB total is what protects the shared secret, and the ingestor ignores what it cannot read.
    """
    if len(raw.encode()) > MAX_WEBSCRAPER_CONFIGS_BYTES:
        return f'configs may be at most {MAX_WEBSCRAPER_CONFIGS_BYTES} bytes'
    if not isinstance(configs, list) or not all(isinstance(config, dict) for config in configs):
        return INVALID_CONFIGS
    if len(configs) > MAX_SCRAPERS:
        return f'At most {MAX_SCRAPERS} scrapers are allowed'
    for config in configs:
        urls = config.get('urls')
        if isinstance(urls, list) and len(urls) > MAX_URLS_PER_SCRAPER:
            return f'A scraper may list at most {MAX_URLS_PER_SCRAPER} urls'
    return None
