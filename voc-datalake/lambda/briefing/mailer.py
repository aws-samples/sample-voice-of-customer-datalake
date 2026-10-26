"""The brief by email: plain text through the brief SNS topic, to the reader only.

Each message carries the reader's ``sub`` as a message attribute; their one email
subscription's filter policy is ``{"sub": [<sub>]}``, so nobody else receives it.
It holds the headline, one line per card, at most ``MAX_QUOTES`` customer quotes —
already PII-redacted and taken only from cards of the reader's own brief (so only
from categories they can see) — and a link to Home. No emojis, no HTML.

SNS requires an ASCII subject under 100 characters, so the subject is a fixed ASCII
line with the date; the body is in the reader's language.
"""
from __future__ import annotations

import os
from collections.abc import Iterable, Mapping
from typing import Any, Final

import boto3

from shared.brief_cards import BriefCard

TOPIC_ENV: Final = 'BRIEFING_TOPIC_ARN'
MAX_QUOTES: Final = 3
MAX_SUBJECT_CHARS: Final = 99
MAX_MESSAGE_CHARS: Final = 60_000

#: The few fixed words of the email, per UI language.
LABELS: Final[Mapping[str, Mapping[str, str]]] = {
    'en': {'cards': 'Today', 'quotes': 'In their words', 'open': 'Open your brief',
           'why': 'You get this email because you turned on the morning brief email. Turn it off in the brief settings on Home.'},
    'es': {'cards': 'Hoy', 'quotes': 'En sus palabras', 'open': 'Abre tu resumen',
           'why': 'Recibes este correo porque activaste el correo del resumen matinal. Desactívalo en los ajustes del resumen en Inicio.'},
    'fr': {'cards': "Aujourd'hui", 'quotes': 'Dans leurs mots', 'open': 'Ouvrir votre brief',
           'why': "Vous recevez cet e-mail car vous avez activé l'e-mail du brief du matin. Désactivez-le dans les réglages du brief sur l'accueil."},
    'de': {'cards': 'Heute', 'quotes': 'In ihren Worten', 'open': 'Briefing öffnen',
           'why': 'Sie erhalten diese E-Mail, weil Sie die E-Mail zum Morgenbriefing aktiviert haben. Deaktivieren Sie sie in den Briefing-Einstellungen auf der Startseite.'},
    'pt': {'cards': 'Hoje', 'quotes': 'Nas palavras deles', 'open': 'Abrir o seu resumo',
           'why': 'Você recebe este e-mail porque ativou o e-mail do resumo matinal. Desative-o nas configurações do resumo na página inicial.'},
    'ja': {'cards': '今日', 'quotes': 'お客様の声', 'open': 'ブリーフを開く',
           'why': '朝のブリーフのメールをオンにしているため、このメールが届いています。ホームのブリーフ設定でオフにできます。'},
    'zh': {'cards': '今天', 'quotes': '客户原话', 'open': '打开简报',
           'why': '您收到此邮件是因为您开启了晨间简报邮件。可在首页的简报设置中关闭。'},
    'ko': {'cards': '오늘', 'quotes': '고객의 목소리', 'open': '브리핑 열기',
           'why': '아침 브리핑 이메일을 켜 두셨기 때문에 이 메일을 받으셨습니다. 홈의 브리핑 설정에서 끌 수 있습니다.'},
    'pl': {'cards': 'Dzisiaj', 'quotes': 'Ich słowami', 'open': 'Otwórz podsumowanie',
           'why': 'Otrzymujesz tę wiadomość, ponieważ włączono e-mail z porannym podsumowaniem. Możesz go wyłączyć w ustawieniach podsumowania na stronie głównej.'},
}

_client: dict[str, Any] = {}


def _sns() -> Any:
    if 'sns' not in _client:
        _client['sns'] = boto3.client('sns')
    return _client['sns']


def quotes_of(cards: Iterable[BriefCard]) -> list[str]:
    """At most ``MAX_QUOTES`` redacted quotes from the cards' facts, in card order."""
    found: list[str] = []
    for card in cards:
        quotes = card.facts.get('quotes')
        for quote in quotes if isinstance(quotes, list) else []:
            text = quote.get('text') if isinstance(quote, Mapping) else None
            if isinstance(text, str) and text:
                found.append(text)
            if len(found) >= MAX_QUOTES:
                return found
    return found


def compose(*, cards: list[BriefCard], headline: str, summary: str, language: str, day: str,
            site_url: str) -> tuple[str, str]:
    """``(subject, message)`` of one reader's brief email."""
    labels = LABELS.get(language, LABELS['en'])
    lines = [headline or day, '']
    if summary:
        lines += [summary, '']
    lines += [f"{labels['cards']}:"] + [f'- {card.title}' for card in cards] + ['']
    quotes = quotes_of(cards)
    if quotes:
        lines += [f"{labels['quotes']}:"] + [f'"{quote}"' for quote in quotes] + ['']
    if site_url:
        lines += [f"{labels['open']}: {site_url}/", '']
    lines.append(labels['why'])
    subject = f'VoC morning brief - {day}'[:MAX_SUBJECT_CHARS]
    return subject, '\n'.join(lines)[:MAX_MESSAGE_CHARS]


def publish(sub: str, subject: str, message: str) -> None:
    """Send to the reader's own subscription only (the ``sub`` attribute their filter policy matches)."""
    topic = os.environ.get(TOPIC_ENV, '')
    if not topic:
        return
    _sns().publish(TopicArn=topic, Subject=subject, Message=message,
                   MessageAttributes={'sub': {'DataType': 'String', 'StringValue': sub}})
