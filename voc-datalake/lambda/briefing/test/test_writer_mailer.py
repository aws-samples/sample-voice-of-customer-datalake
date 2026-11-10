"""The words (briefing/writer.py) and the email (briefing/mailer.py)."""
import json
from unittest.mock import MagicMock

import pytest

from briefing import mailer, writer
from shared.brief_cards import BriefCard
from shared.briefing_prefs import LANGUAGES
from shared.converse import BedrockThrottlingError


def _card(card_id: str, **facts) -> BriefCard:
    return BriefCard(id=card_id, kind='trending_topic', layer='org', severity='info', title=f'code {card_id}',
                     facts=facts, feedback_ids=(f'fb-{card_id}',))


A, B = _card('trending_topic_aaaaaaaaaaaaaaaa', category='shipping'), _card('trending_topic_bbbbbbbbbbbbbbbb')


def _model(monkeypatch, answer: object) -> MagicMock:
    fake = MagicMock(return_value=answer if isinstance(answer, str) else json.dumps(answer))
    monkeypatch.setattr(writer, 'converse', fake)
    return fake


class TestApplyWords:
    def test_the_answer_orders_and_rewords(self):
        cards = writer.apply_words([A, B], {'cards': [{'id': B.id, 'title': 'New B'}]})
        assert [(c.id, c.title) for c in cards] == [(B.id, 'New B'), (A.id, 'code ' + A.id)]

    def test_an_unknown_id_is_ignored(self):
        assert writer.apply_words([A], {'cards': [{'id': 'made_up', 'title': 'x'}]}) == [A]

    def test_text_around_the_json_is_tolerated(self):
        assert writer.parse_json_object('Sure! {"summary": "ok"} done') == {'summary': 'ok'}


class TestWriteOrg:
    def test_one_call_writes_words_and_grounded_ideas(self, monkeypatch):
        fake = _model(monkeypatch, {'summary': 'Busy week', 'cards': [{'id': A.id, 'title': 'Shipping up'}],
                                    'ideas': [{'title': 'Check couriers', 'based_on': [A.id]},
                                              {'title': 'Baseless', 'based_on': ['nope']}]})
        words = writer.write_org([A, B], 'GROUNDING', '2026-10-17')
        assert (fake.call_count, words.summary, words.cards[0].title) == (1, 'Busy week', 'Shipping up')
        [idea] = words.extra
        assert (idea.title, idea.feedback_ids, idea.facts['categories']) == ('Check couriers', (f'fb-{A.id}',),
                                                                           ['shipping'])

    def test_the_model_reads_facts_as_data_on_the_utility_surface(self, monkeypatch):
        fake = _model(monkeypatch, {'cards': []})
        writer.write_org([A], 'GROUNDING', '2026-10-17')
        kwargs = fake.call_args.kwargs
        assert kwargs['surface'] == 'utility'
        assert '<brief_facts>' in kwargs['prompt']
        assert 'GROUNDING' in kwargs['prompt']

    def test_no_cards_no_call(self, monkeypatch):
        fake = _model(monkeypatch, {})
        assert writer.write_org([], '', '2026-10-17').model_calls == 0
        fake.assert_not_called()

    @pytest.mark.parametrize('fault', [BedrockThrottlingError('slow down'), ValueError('bad')])
    def test_a_failed_call_keeps_the_code_words(self, monkeypatch, fault):
        monkeypatch.setattr(writer, 'converse', MagicMock(side_effect=fault))
        words = writer.write_org([A], '', '2026-10-17')
        assert (words.failed, words.cards) == (True, [A])

    def test_an_unreadable_answer_keeps_the_code_words(self, monkeypatch):
        _model(monkeypatch, 'no json here')
        assert writer.write_org([A], '', '2026-10-17').cards == [A]


class TestWritePersonal:
    def _input(self, **overrides):
        base = {'cards': [A], 'grounding_text': 'MINE', 'instructions': 'Focus on couriers', 'language': 'de',
                'projects': ['Checkout'], 'day': '2026-10-17'}
        return writer.PersonalInput(**{**base, **overrides})

    def test_instructions_are_a_data_block_and_the_language_is_asked_for(self, monkeypatch):
        fake = _model(monkeypatch, {'headline': 'Guten Morgen', 'cards': []})
        words = writer.write_personal(self._input())
        kwargs = fake.call_args.kwargs
        assert '<brief_instructions>' in kwargs['prompt']
        assert 'Checkout' in kwargs['prompt']
        assert 'German' in kwargs['system_prompt']
        assert words.headline == 'Guten Morgen'

    def test_personal_notes_carry_an_assistant_prompt(self, monkeypatch):
        _model(monkeypatch, {'personal': [{'title': 'Your OKR', 'body': 'b', 'prompt': 'Compare with Q3'},
                                          {'title': ''}]})
        [note] = writer.write_personal(self._input()).extra
        assert (note.kind, note.layer, note.actions[0].prompt) == ('personal_note', 'personal', 'Compare with Q3')

    def test_the_note_button_is_in_the_brief_language(self, monkeypatch):
        # Live (5.17.00): a Polish brief showed the English button "Ask the assistant".
        _model(monkeypatch, {'personal': [{'title': 'Twój cel', 'body': 'b', 'prompt': 'Porównaj z Q3'}]})
        [note] = writer.write_personal(self._input(language='pl')).extra
        assert note.actions[0].label == 'Zapytaj asystenta'

    def test_every_brief_language_has_a_note_button_label(self):
        assert set(writer.ASK_LABELS) == set(LANGUAGES)


class TestMailer:
    def test_at_most_three_quotes(self):
        quotes = [{'feedback_id': f'f{i}', 'text': f'quote {i}'} for i in range(5)]
        card = _card('trending_topic_cccccccccccccccc', quotes=quotes)
        assert mailer.quotes_of([card, card]) == ['quote 0', 'quote 1', 'quote 2']

    def test_the_message_is_plain_text_with_a_link_home(self):
        subject, message = mailer.compose(cards=[A], headline='Morning', summary='Busy', language='fr',
                                          day='2026-10-17', site_url='https://voc.example.com')
        assert subject == 'VoC morning brief - 2026-10-17'
        assert subject.isascii()
        assert 'Ouvrir votre brief: https://voc.example.com/' in message.splitlines()
        assert "Aujourd'hui:" in message

    def test_no_link_without_a_site(self):
        _, message = mailer.compose(cards=[A], headline='', summary='', language='en', day='d', site_url='')
        assert 'http' not in message

    def test_every_brief_language_has_its_email_words(self):
        # A language added to the brief without email words would mail English labels silently.
        assert set(mailer.LABELS) == set(LANGUAGES)
        assert all(set(words) == set(mailer.LABELS['en']) for words in mailer.LABELS.values())

    def test_a_polish_reader_gets_polish_email_words(self):
        _, message = mailer.compose(cards=[A], headline='', summary='', language='pl', day='d',
                                    site_url='https://voc.example.com')
        assert 'Otwórz podsumowanie: https://voc.example.com/' in message.splitlines()
        assert 'Dzisiaj:' in message

    def test_publish_targets_the_readers_own_filter(self, monkeypatch):
        sns = MagicMock()
        monkeypatch.setattr(mailer, '_client', {'sns': sns})
        monkeypatch.setenv('BRIEFING_TOPIC_ARN', 'arn:aws:sns:us-east-1:123456789012:voc-briefing')
        mailer.publish('sub-ana', 'S', 'M')
        assert sns.publish.call_args.kwargs['MessageAttributes'] == {
            'sub': {'DataType': 'String', 'StringValue': 'sub-ana'}}
