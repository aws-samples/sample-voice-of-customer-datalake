"""GET/PUT /radar/brands and GET /radar/brands/{brand}/reviews/{id} (the brand list, docs/radar.md)."""
from decimal import Decimal

import pytest
from category_access_fixtures import RESTRICTED_CLAIMS, RESTRICTED_SUB
from test_radar_handler import ADMIN, PROFILES, _call, _today, radar_tables

from shared.category_access import access_key
from shared.radar_brands import BRAND_LIST_KEY
from shared.radar_store import radar_item, store_item

LISTED = [{'label': 'Initech', 'domains': ['initech.com']}, {'label': 'Acme', 'domains': ['acme.io']}]


def _detail_review(feedback_id='i1', category='billing'):
    return {
        'feedback_id': feedback_id, 'date': _today(), 'category': category, 'subcategory': None,
        'sentiment_label': 'negative', 'sentiment_score': Decimal('-0.5'), 'source_platform': 'initech_scraper',
        'original_text': 'Charged twice, mail ana@example.com', 'author': 'Ana', 'author_email': 'ana@example.com',
        'persona_name': 'Busy Parent', 'persona_type': 'household', 'journey_stage': 'billing',
        'impact_area': 'revenue', 'problem_root_cause_hypothesis': 'Retry sends a second charge',
        'source_created_at': f'{_today()}T08:00:00+00:00', 'source_channel': 'web', 'language': 'en',
    }


@pytest.fixture
def tables():
    with radar_tables() as (radar, aggregates):
        radar.put_item(Item={**BRAND_LIST_KEY, 'brands': LISTED, 'updated_at': 'then', 'updated_by': 'ada'})
        store_item(radar, 'initech', radar_item(_detail_review(), 'initech', 'Initech'))
        yield radar, aggregates


def _brands(tables, lambda_context, claims=ADMIN):
    status, body, _ = _call(tables, lambda_context, 'GET', '/radar/brands', claims=claims)
    assert status == 200
    return body['brands']


class TestListing:
    def test_the_list_comes_first_then_legacy_profile_brands(self, tables, lambda_context):
        brands = _brands(tables, lambda_context)
        assert [(b['key'], b['origin']) for b in brands] == [('initech', 'list'), ('acme', 'list'),
                                                              ('globex', 'profile')]

    def test_a_listed_brand_a_profile_also_names_keeps_the_list_label_and_gains_the_profile(
            self, tables, lambda_context):
        acme = _brands(tables, lambda_context)[1]
        assert (acme['label'], acme['domains'], acme['sources']) == ('Acme', ['acme.io', 'acme.com'], ['rival_reviews'])

    def test_a_listed_brand_without_sources_is_visible_to_every_user_a_restricted_one_is_not(
            self, tables, lambda_context):
        assert [b['key'] for b in _brands(tables, lambda_context, claims={'sub': 'u', 'cognito:groups': 'users'})] == [
            'initech', 'acme']

    def test_a_legacy_profile_brand_still_works_without_any_list(self, lambda_context):
        # Back-compat (prod: profile radar_example_air -> Example Air): no brand list saved at all.
        with radar_tables() as (radar, aggregates):
            aggregates.put_item(Item={**PROFILES, 'sources': [{'id': 'radar_example_air', 'radar_brand': 'Example Air'}]})
            brands = _brands((radar, aggregates), lambda_context)
            status, _, _ = _call((radar, aggregates), lambda_context, 'GET', '/radar/brands/example-air')
        assert [(b['key'], b['origin'], b['sources']) for b in brands] == [('example-air', 'profile', ['radar_example_air'])]
        assert status == 200

    def test_the_exact_route_does_not_shadow_one_brand(self, tables, lambda_context):
        status, body, _ = _call(tables, lambda_context, 'GET', '/radar/brands/initech')
        assert (status, body['brand']['origin'], body['total']) == (200, 'list', 1)


class TestSaving:
    def test_only_admins_save_the_list(self, tables, lambda_context):
        status, _, _ = _call(tables, lambda_context, 'PUT', '/radar/brands', body={'brands': []})
        assert status == 403

    def test_a_save_normalises_and_answers_the_listing(self, tables, lambda_context):
        status, body, _ = _call(tables, lambda_context, 'PUT', '/radar/brands', claims=ADMIN, body={
            'brands': [{'label': '  Hooli   Inc ', 'domains': ['https://www.Hooli.com/about']}]})
        assert (status, body['success']) == (200, True)
        assert [(b['key'], b['label'], b['domains']) for b in body['brands'] if b['origin'] == 'list'] == [
            ('hooli-inc', 'Hooli Inc', ['hooli.com'])]
        assert body['brands'] == _brands(tables, lambda_context)

    @pytest.mark.parametrize('brands', [
        'Acme',
        [{'label': 'Acme'}, {'label': 'ACME'}],
        [{'label': '<script>'}],
        [{'label': 'ヤマト'}],
        [{'label': 'Acme', 'domains': ['not a domain']}],
        [{'label': 'Acme', 'domains': [f'd{n}.com' for n in range(11)]}],
        [{'label': f'Brand {n}'} for n in range(26)],
    ])
    def test_an_invalid_list_is_a_400_and_nothing_is_stored(self, tables, lambda_context, brands):
        radar, _ = tables
        status, _, _ = _call(tables, lambda_context, 'PUT', '/radar/brands', claims=ADMIN, body={'brands': brands})
        assert status == 400
        assert radar.get_item(Key=BRAND_LIST_KEY)['Item']['brands'] == LISTED

    def test_removing_a_brand_keeps_its_reviews_and_the_scan_settings(self, tables, lambda_context):
        radar, _ = tables
        _call(tables, lambda_context, 'PUT', '/radar/settings', claims=ADMIN, body={'cadence': 'daily'})
        _call(tables, lambda_context, 'PUT', '/radar/brands', claims=ADMIN, body={'brands': []})
        assert radar.get_item(Key={'pk': 'RADARID#initech', 'sk': 'i1'}).get('Item')
        assert _call(tables, lambda_context, 'GET', '/radar/settings')[1]['settings']['cadence'] == 'daily'
        assert 'initech' not in [b['key'] for b in _brands(tables, lambda_context)]

    def test_saving_the_scan_settings_never_clobbers_the_list(self, tables, lambda_context):
        radar, _ = tables
        _call(tables, lambda_context, 'PUT', '/radar/settings', claims=ADMIN, body={'cadence': 'monthly'})
        assert radar.get_item(Key=BRAND_LIST_KEY)['Item']['brands'] == LISTED

    def test_scan_now_covers_a_listed_brand_without_any_radar_profile(self, tables, lambda_context):
        _, aggregates = tables
        aggregates.put_item(Item={**PROFILES, 'sources': [{'id': 'web'}]})
        status, _, start = _call(tables, lambda_context, 'POST', '/radar/scan', claims=ADMIN, body={'brand': 'initech'})
        assert status == 202
        start.assert_called_once()


class TestSingleReview:
    PATH = '/radar/brands/initech/reviews/i1'

    def test_one_review_carries_its_enrichment_redacted_and_never_the_author(self, tables, lambda_context):
        status, body, _ = _call(tables, lambda_context, 'GET', self.PATH)
        review = body['review']
        assert (status, body['brand']) == (200, {'key': 'initech', 'label': 'Initech'})
        assert (review['feedback_id'], review['persona_name'], review['problem_root_cause_hypothesis'],
                review['language'], review['source_channel']) == (
            'i1', 'Busy Parent', 'Retry sends a second charge', 'en', 'web')
        assert 'ana@example.com' not in str(review)
        assert not {'author', 'author_email'} & set(review)

    @pytest.mark.parametrize('path', [
        '/radar/brands/initech/reviews/nope',     # no such review
        '/radar/brands/acme/reviews/i1',          # another brand's id
        '/radar/brands/unknown/reviews/i1',       # no such brand
        f'/radar/brands/initech/reviews/{"x" * 300}',
    ])
    def test_an_absent_review_is_a_404(self, tables, lambda_context, path):
        assert _call(tables, lambda_context, 'GET', path)[0] == 404

    def test_a_category_the_caller_may_not_see_is_a_404(self, tables, lambda_context):
        _, aggregates = tables
        aggregates.put_item(Item={**access_key(RESTRICTED_SUB), 'categories': ['delivery']})
        assert _call(tables, lambda_context, 'GET', self.PATH, claims=RESTRICTED_CLAIMS)[0] == 404
        assert _call(tables, lambda_context, 'GET', self.PATH, claims=ADMIN)[0] == 200

    def test_a_hidden_brand_hides_its_reviews(self, tables, lambda_context):
        radar, _ = tables
        store_item(radar, 'globex', radar_item({**_detail_review('g1'), 'source_platform': 'secret_rival'},
                                               'globex', 'Globex'))
        path = '/radar/brands/globex/reviews/g1'
        assert _call(tables, lambda_context, 'GET', path)[0] == 404
        assert _call(tables, lambda_context, 'GET', path, claims=ADMIN)[0] == 200
