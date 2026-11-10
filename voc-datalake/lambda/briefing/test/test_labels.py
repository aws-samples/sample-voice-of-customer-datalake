"""Regression (prod 5.14): a brief card read "Software_firmware spiked" — the writer saw category ids.

Cards keep the id in ``category`` / ``categories`` (the scope check reads them) and carry the
display label (configured short name, else the humanised id) beside it; the code-written titles
use the label, and the writer is told to name categories only by their labels.
"""
from datetime import timedelta

from briefing import providers, writer
from briefing.test.conftest import NOW
from shared.api import clear_categories_cache
from shared.brief_cards import BriefContext
from shared.category_access import UNRESTRICTED

CATEGORIES = [
    {'name': 'software_firmware', 'description': 'Software & Firmware', 'subcategories': []},
    {'name': 'ease_of_use', 'description': '', 'subcategories': []},
]


def _day(days_ago: int) -> str:
    return (NOW - timedelta(days=days_ago)).strftime('%Y-%m-%d')


def _spiking(world) -> BriefContext:
    world.tables.aggregates.put_item(Item={'pk': 'SETTINGS#categories', 'sk': 'config', 'categories': CATEGORIES})
    clear_categories_cache()
    for name in ('software_firmware', 'ease_of_use'):
        for days_ago in range(1, 14):
            world.counter(f'METRIC#daily_category#{name}', _day(days_ago), 1)
        world.counter(f'METRIC#daily_category#{name}', _day(0), 12)
    return BriefContext(feedback_table=world.tables.feedback, aggregates_table=world.tables.aggregates,
                        scope=UNRESTRICTED, now=NOW)


def test_a_spike_title_names_the_configured_label_and_keeps_the_id_in_facts(world):
    cards = {c.facts['category']: c for c in providers.spike_alert_cards(_spiking(world))}
    assert (cards['software_firmware'].title.startswith('Spike in Software & Firmware:'),
            cards['software_firmware'].facts['category_label']) == (True, 'Software & Firmware')


def test_a_category_without_a_short_name_reads_as_its_humanised_id(world):
    cards = {c.facts['category']: c for c in providers.spike_alert_cards(_spiking(world))}
    assert (cards['ease_of_use'].facts['category_label'], 'ease_of_use' in cards['ease_of_use'].title) == (
        'Ease of use', False)


def test_no_code_written_title_carries_a_raw_id(world):
    ctx = _spiking(world)
    titles = [c.title for c in providers.run_providers(providers.PROVIDERS, ctx)]
    assert titles
    assert not [t for t in titles if 'software_firmware' in t.lower() or 'ease_of_use' in t.lower()]


def test_the_writer_sees_the_labels_and_is_told_to_use_them(world):
    [card, *_] = providers.spike_alert_cards(_spiking(world))
    [payload] = writer.facts_payload([card])
    assert ('category_label' in payload['facts'], 'category_label' in writer.ORG_SYSTEM,
            'never shown to the reader' in writer.PERSONAL_SYSTEM) == (True, True, True)
