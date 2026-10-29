"""The Radar news scan's query plan: what to search for a brand, in its language and in English (docs/radar.md).

Six kinds of query (``QUERY_TYPES``): new features / release, launch / premiere, promotion / discount,
partnership / integration, announcement, and company news. The first five quote the brand name
(``"Acme" nowe funkcje``); company news does not (``Acme aktualności``). None is domain-restricted:
the own-domain step (``own_domain_query``) is separate.

A brand's plan is every type in its EFFECTIVE language, then every type in English (once when
the brand's language is English). A scan rarely affords the whole plan, so it runs a window of it
starting at the brand's stored cursor (``rotated``) and stores the cursor after the queries it ran:
successive scans cover every type in turn, deterministically.

A brand's ``search_terms`` / ``exclude_terms`` (shared/radar_brand_terms.py) decorate a query
(``with_terms``): the search terms as one OR group of quoted phrases (``("Example Air Ltd" OR
"Example Air Miles")``) on the general news queries only (a domain-restricted query is already about the
brand), the exclude terms as ``-"term"`` on every web query. Whole terms only, in the order given,
as many as fit ``MAX_QUERY_CHARS``.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Final

from shared.radar_brand_fields import DEFAULT_LANGUAGE

#: The web-search connector's query cap (shared/web_search.MAX_QUERY_LENGTH); terms that would pass it are left out.
MAX_QUERY_CHARS: Final = 200

QUERY_TYPES: Final = ('features', 'launch', 'promotion', 'partnership', 'announcement', 'company_news')

#: A few search words per language and query type. Every language of ``radar_brand_fields.LANGUAGES``.
QUERY_WORDS: Final[dict[str, dict[str, str]]] = {
    'en': {'features': 'new features release', 'launch': 'launch', 'promotion': 'promotion discount',
           'partnership': 'partnership integration', 'announcement': 'announcement', 'company_news': 'news'},
    'pl': {'features': 'nowe funkcje nowa wersja', 'launch': 'premiera', 'promotion': 'promocja rabat',
           'partnership': 'partnerstwo integracja', 'announcement': 'ogłasza', 'company_news': 'aktualności'},
    'cs': {'features': 'nové funkce nová verze', 'launch': 'spuštění novinka', 'promotion': 'akce sleva',
           'partnership': 'partnerství integrace', 'announcement': 'oznámení', 'company_news': 'novinky'},
    'sk': {'features': 'nové funkcie nová verzia', 'launch': 'spustenie novinka', 'promotion': 'akcia zľava',
           'partnership': 'partnerstvo integrácia', 'announcement': 'oznámenie', 'company_news': 'novinky'},
    'de': {'features': 'neue Funktionen neue Version', 'launch': 'Einführung Neuheit', 'promotion': 'Aktion Rabatt',
           'partnership': 'Partnerschaft Integration', 'announcement': 'Ankündigung', 'company_news': 'Neuigkeiten'},
    'fr': {'features': 'nouvelles fonctionnalités nouvelle version', 'launch': 'lancement',
           'promotion': 'promotion réduction', 'partnership': 'partenariat intégration', 'announcement': 'annonce',
           'company_news': 'actualités'},
    'es': {'features': 'nuevas funciones nueva versión', 'launch': 'lanzamiento', 'promotion': 'promoción descuento',
           'partnership': 'alianza integración', 'announcement': 'anuncia', 'company_news': 'noticias'},
    'it': {'features': 'nuove funzionalità nuova versione', 'launch': 'lancio', 'promotion': 'promozione sconto',
           'partnership': 'partnership integrazione', 'announcement': 'annuncia', 'company_news': 'notizie'},
    'pt': {'features': 'novas funcionalidades nova versão', 'launch': 'lançamento', 'promotion': 'promoção desconto',
           'partnership': 'parceria integração', 'announcement': 'anuncia', 'company_news': 'notícias'},
    'nl': {'features': 'nieuwe functies nieuwe versie', 'launch': 'lancering', 'promotion': 'actie korting',
           'partnership': 'partnerschap integratie', 'announcement': 'aankondiging', 'company_news': 'nieuws'},
    'sv': {'features': 'nya funktioner ny version', 'launch': 'lansering', 'promotion': 'kampanj rabatt',
           'partnership': 'partnerskap integration', 'announcement': 'meddelar', 'company_news': 'nyheter'},
    'da': {'features': 'nye funktioner ny version', 'launch': 'lancering', 'promotion': 'kampagne rabat',
           'partnership': 'partnerskab integration', 'announcement': 'meddelelse', 'company_news': 'nyheder'},
    'fi': {'features': 'uudet ominaisuudet uusi versio', 'launch': 'julkaisu lanseeraus',
           'promotion': 'kampanja alennus', 'partnership': 'kumppanuus integraatio', 'announcement': 'tiedote',
           'company_news': 'uutiset'},
    'no': {'features': 'nye funksjoner ny versjon', 'launch': 'lansering', 'promotion': 'kampanje rabatt',
           'partnership': 'partnerskap integrasjon', 'announcement': 'kunngjøring', 'company_news': 'nyheter'},
    'hu': {'features': 'új funkciók új verzió', 'launch': 'bevezetés újdonság', 'promotion': 'akció kedvezmény',
           'partnership': 'partnerség integráció', 'announcement': 'bejelentés', 'company_news': 'hírek'},
    'ro': {'features': 'funcții noi versiune nouă', 'launch': 'lansare', 'promotion': 'promoție reducere',
           'partnership': 'parteneriat integrare', 'announcement': 'anunță', 'company_news': 'știri'},
}


@dataclass(frozen=True)
class PlannedQuery:
    """One search of the plan: its type, its language and the query text."""

    type: str
    language: str
    text: str


def _words(language: str) -> dict[str, str]:
    return QUERY_WORDS.get(language, QUERY_WORDS[DEFAULT_LANGUAGE])


def query_text(label: str, query_type: str, language: str) -> str:
    """``"<brand>" <words>`` (company news: the brand unquoted, a looser match)."""
    words = _words(language)[query_type]
    return f'{label} {words}' if query_type == 'company_news' else f'"{label}" {words}'


def plan_languages(language: str) -> tuple[str, ...]:
    """The brand's language, then English (once when they are the same)."""
    return tuple(dict.fromkeys((language, DEFAULT_LANGUAGE)))


def query_plan(label: str, language: str) -> list[PlannedQuery]:
    """Every query type in the brand's language, then in English."""
    return [PlannedQuery(query_type, lang, query_text(label, query_type, lang))
            for lang in plan_languages(language) for query_type in QUERY_TYPES]


def rotated(plan: list[PlannedQuery], cursor: int) -> list[PlannedQuery]:
    """``plan`` starting at ``cursor`` (wrapping), so a short budget walks the whole plan over successive scans."""
    if not plan:
        return []
    start = cursor % len(plan)
    return [*plan[start:], *plan[:start]]


def own_domain_query(label: str, language: str) -> str:
    """The own-domain step's one query: the brand's news, in its language, on its own sites."""
    return f'{label} {_words(language)["company_news"]}'


def _fits(text: str, extra: str) -> bool:
    return len(text) + len(extra) <= MAX_QUERY_CHARS


def _group(terms: list[str]) -> str:
    """``"a"`` for one term, ``("a" OR "b")`` for more."""
    quoted = [f'"{term}"' for term in terms]
    return quoted[0] if len(quoted) == 1 else f'({" OR ".join(quoted)})'


def _any_of(base: str, terms: tuple[str, ...]) -> str:
    """``base`` plus the longest prefix of ``terms`` that fits, as one group."""
    kept: list[str] = []
    for term in terms:
        if not _fits(base, f' {_group([*kept, term])}'):
            break
        kept.append(term)
    return f'{base} {_group(kept)}' if kept else base


def with_terms(text: str, search_terms: tuple[str, ...] = (), exclude_terms: tuple[str, ...] = ()) -> str:
    """``text`` with the brand's search terms (an OR group) and its exclusions (``-"term"``), as many as fit."""
    out = _any_of(text, search_terms) if search_terms else text
    for term in exclude_terms:
        extra = f' -"{term}"'
        if _fits(out, extra):
            out += extra
    return out


def plain_terms(text: str, search_terms: tuple[str, ...]) -> str:
    """``text`` with the search terms appended as plain words (Exa: a neural index without OR syntax)."""
    out = text
    for term in search_terms:
        if _fits(out, f' {term}'):
            out += f' {term}'
    return out
