"""Mutation hardening for `_shared/github_mapping.py`.

`github_issues/test/test_github_mapping.py` maps one well-formed issue and one
comment and checks the headline fields, but a mutation run found what it could
not see:

* the exact caps: 4,000 characters of issue text, 2,000 of comment text, 30
  labels of at most 100 characters, a 256-character milestone and a
  500-character title — each pinned at the cap and one past it.
* every malformed-payload default: labels that are plain strings, nameless,
  blank or ``None``; a user that is not an object or a login that is not a
  string; reactions and comment counts that are missing or not integers; a
  milestone that is empty or not an object; a missing title or body.
* every top-level item key (``created_at``, ``url``, ``author``, ``title``)
  and the issue-only ``state_reason``, through whole-item equality, so a
  renamed or misread key fails.
* the comment's inheritance from its issue: state and milestone, a component
  from the issue's FORM (not only from an ``area:`` label), and an
  issue-label version that the comment inherits but never claims as its own.
"""
import pytest

from _shared.github_mapping import (
    RAW_PAYLOAD_KEY,
    comment_item,
    is_bot,
    is_pull_request,
    issue_item,
    issue_labels,
)

REPO = 'octo/app'


def _bare_issue(**fields: object) -> dict:
    return {'number': 5, **fields}


def _bare_comment(**fields: object) -> dict:
    return {'id': 9, **fields}


class TestABareIssueMapsToExactlyItsDefaults:
    def test_a_payload_with_only_a_number_and_title(self):
        payload = _bare_issue(title='  Crash on save  ')

        assert issue_item(payload, REPO) == {
            'id': 'octo/app#5',
            'text': 'Crash on save',
            'created_at': None,
            'url': None,
            'channel': 'issue',
            'author': None,
            'title': 'Crash on save',
            'issue_attributes': {
                'kind': 'issue',
                'repo': REPO,
                'number': 5,
                'labels': [],
                'plus_one': 0,
                'reactions_total': 0,
                'linked_prs': [],
                'comment_count': 0,
                'has_repro': False,
            },
            RAW_PAYLOAD_KEY: payload,
        }

    def test_no_title_and_no_body_falls_back_to_the_number(self):
        item = issue_item({'number': '12', 'title': None, 'body': None}, REPO)

        assert item['text'] == 'Issue #12'
        assert item['title'] == ''
        assert item['id'] == 'octo/app#12'
        assert item['issue_attributes']['number'] == 12

    def test_a_body_without_a_title_is_the_text_on_its_own(self):
        item = issue_item(_bare_issue(body='It crashes'), REPO)

        assert item['text'] == 'It crashes'
        assert item['title'] == ''


class TestEveryIssueFieldIsReadFromItsOwnKey:
    def test_the_top_level_and_passthrough_fields(self):
        item = issue_item(_bare_issue(
            title='T',
            created_at='2026-03-01T00:00:00Z',
            html_url='https://github.com/octo/app/issues/5',
            user={'login': 'ada', 'type': 'User'},
            state='closed',
            state_reason='completed',
            author_association='MEMBER',
            updated_at='2026-03-02T00:00:00Z',
            comments=4,
            reactions={'+1': 2, 'total_count': 5},
            milestone={'title': 'Q2'},
        ), REPO)

        assert item['created_at'] == '2026-03-01T00:00:00Z'
        assert item['url'] == 'https://github.com/octo/app/issues/5'
        assert item['author'] == 'ada'
        assert item['issue_attributes'] == {
            'kind': 'issue',
            'repo': REPO,
            'number': 5,
            'state': 'closed',
            'state_reason': 'completed',
            'labels': [],
            'plus_one': 2,
            'reactions_total': 5,
            'author_association': 'MEMBER',
            'milestone': 'Q2',
            'linked_prs': [],
            'comment_count': 4,
            'updated_at': '2026-03-02T00:00:00Z',
            'has_repro': False,
        }


class TestMalformedPayloadsFallBackToSafeDefaults:
    @pytest.mark.parametrize('user', [None, 'ada', {'login': 7}, {'type': 'User'}])
    def test_an_unreadable_author_is_none(self, user):
        assert issue_item(_bare_issue(user=user), REPO)['author'] is None

    @pytest.mark.parametrize(('reactions', 'expected'), [
        (None, (0, 0)),
        ('lots', (0, 0)),
        ({}, (0, 0)),
        ({'+1': '3', 'total_count': '4'}, (0, 0)),
        ({'+1': 3}, (3, 0)),
        ({'total_count': 4}, (0, 4)),
    ])
    def test_reactions_count_only_integers(self, reactions, expected):
        attributes = issue_item(_bare_issue(reactions=reactions), REPO)['issue_attributes']
        assert (attributes['plus_one'], attributes['reactions_total']) == expected

    @pytest.mark.parametrize('comments', [None, '4', 4.0])
    def test_a_non_integer_comment_count_is_zero(self, comments):
        assert issue_item(_bare_issue(comments=comments), REPO)['issue_attributes']['comment_count'] == 0

    @pytest.mark.parametrize('milestone', [None, 'Q2', {'title': ''}, {'title': 3}, {}])
    def test_an_unreadable_milestone_is_omitted(self, milestone):
        assert 'milestone' not in issue_item(_bare_issue(milestone=milestone), REPO)['issue_attributes']


class TestTheCaps:
    def test_issue_text_is_capped_at_4000_characters(self):
        item = issue_item(_bare_issue(title='T', body='a' * 5000), REPO)
        assert item['text'] == 'T\n\n' + 'a' * 3997
        assert len(item['text']) == 4000

    def test_comment_text_keeps_2000_characters_of_body_after_the_title(self):
        item = comment_item(_bare_comment(body='a' * 3000), REPO, _bare_issue(title='T'))
        assert item['text'] == 'Re: T\n\n' + 'a' * 1999 + '…'

    def test_issue_title_is_capped_at_500(self):
        assert issue_item(_bare_issue(title='t' * 501), REPO)['title'] == 't' * 500

    def test_comment_title_is_capped_at_500(self):
        item = comment_item(_bare_comment(), REPO, _bare_issue(title='t' * 600))
        assert item['title'] == 'Re: ' + 't' * 496

    @pytest.mark.parametrize(('length', 'kept'), [(256, 256), (257, 256)])
    def test_milestone_is_capped_at_256(self, length, kept):
        attributes = issue_item(_bare_issue(milestone={'title': 'm' * length}), REPO)['issue_attributes']
        assert attributes['milestone'] == 'm' * kept

    @pytest.mark.parametrize(('length', 'kept'), [(100, 100), (101, 100)])
    def test_a_label_name_is_capped_at_100(self, length, kept):
        assert issue_labels({'labels': [{'name': 'x' * length}]}) == ['x' * kept]

    @pytest.mark.parametrize(('count', 'kept'), [(30, 30), (31, 30)])
    def test_at_most_30_labels_are_kept_in_order(self, count, kept):
        labels = [{'name': f'l{n}'} for n in range(count)]
        assert issue_labels({'labels': labels}) == [f'l{n}' for n in range(kept)]


class TestLabelNames:
    def test_only_non_blank_string_names_are_kept_and_stripped(self):
        labels = [{'name': ' bug '}, 'plain', {'name': None}, {'name': 3}, {'name': '   '}, {}, 7, None]
        assert issue_labels({'labels': labels}) == ['bug', 'plain']

    def test_missing_labels_are_an_empty_list(self):
        assert issue_labels({'labels': None}) == []


class TestACommentItem:
    def test_a_bare_comment_on_a_bare_issue(self):
        payload = _bare_comment()

        assert comment_item(payload, REPO, _bare_issue(title=' Crash ')) == {
            'id': 'octo/app#5/comment-9',
            'text': 'Re: Crash',
            'created_at': None,
            'url': None,
            'channel': 'comment',
            'author': None,
            'title': 'Re: Crash',
            'issue_attributes': {
                'kind': 'comment',
                'repo': REPO,
                'number': 5,
                'parent_id': 'octo/app#5',
                'labels': [],
                'plus_one': 0,
                'reactions_total': 0,
                'linked_prs': [],
                'has_repro': False,
            },
            RAW_PAYLOAD_KEY: payload,
        }

    def test_reads_its_own_fields_and_the_issue_state_and_milestone(self):
        comment = _bare_comment(
            body='Fails with PR #12\n\nTypeError: boom\n\nSteps to reproduce: open it',
            created_at='2026-03-03T00:00:00Z',
            updated_at='2026-03-04T00:00:00Z',
            html_url='https://github.com/octo/app/issues/5#issuecomment-9',
            user={'login': 'bob'},
            author_association='CONTRIBUTOR',
            reactions={'+1': 1, 'total_count': 2},
        )
        parent = _bare_issue(title='T', state='open', state_reason='reopened', milestone={'title': 'Q2'}, comments=3)

        item = comment_item(comment, REPO, parent)

        assert item['created_at'] == '2026-03-03T00:00:00Z'
        assert item['url'] == 'https://github.com/octo/app/issues/5#issuecomment-9'
        assert item['author'] == 'bob'
        assert item['issue_attributes'] == {
            'kind': 'comment',
            'repo': REPO,
            'number': 5,
            'parent_id': 'octo/app#5',
            'state': 'open',
            'labels': [],
            'plus_one': 1,
            'reactions_total': 2,
            'author_association': 'CONTRIBUTOR',
            'milestone': 'Q2',
            'linked_prs': [12],
            'updated_at': '2026-03-04T00:00:00Z',
            'error_signature': 'typeerror: boom',
            'has_repro': True,
        }

    def test_a_comment_on_an_untitled_issue_is_re_nothing(self):
        item = comment_item(_bare_comment(body='Same'), REPO, _bare_issue(title=None))
        assert (item['text'], item['title']) == ('Re: \n\nSame', 'Re: ')

    def test_the_component_comes_from_the_issue_form(self):
        parent = _bare_issue(body='### Component\n\nEditor')
        assert comment_item(_bare_comment(), REPO, parent)['issue_attributes']['component'] == 'editor'

    def test_an_issue_label_version_is_inherited_not_claimed(self):
        parent = _bare_issue(labels=[{'name': 'v2.0.0'}])
        item = comment_item(_bare_comment(body='Same here'), REPO, parent)
        attributes = item['issue_attributes']
        assert attributes['software_version'] == '2.0.0'
        assert attributes['version_source'] == 'label'

    def test_its_own_product_version_needs_the_product_names(self):
        parent = _bare_issue()
        comment = _bare_comment(body='Broken on Acme 3.1.4')

        assert 'software_version' not in comment_item(comment, REPO, parent)['issue_attributes']
        attributes = comment_item(comment, REPO, parent, ['Acme'])['issue_attributes']
        assert (attributes['software_version'], attributes['version_source']) == ('3.1.4', 'body')


class TestRecognisers:
    @pytest.mark.parametrize(('payload', 'expected'), [
        ({'pull_request': None}, True),
        ({'pull_request': {'url': 'x'}}, True),
        ({'number': 1}, False),
    ])
    def test_a_pull_request_is_any_payload_with_the_key(self, payload, expected):
        assert is_pull_request(payload) is expected

    @pytest.mark.parametrize(('user', 'expected'), [
        ({'type': 'Bot'}, True),
        ({'type': 'User'}, False),
        ({'type': 'bot'}, False),
        ('Bot', False),
        (None, False),
    ])
    def test_only_a_user_object_of_type_bot_is_a_bot(self, user, expected):
        assert is_bot({'user': user}) is expected
