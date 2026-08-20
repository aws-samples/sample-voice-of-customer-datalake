"""Tests for the MCP credential format and the two reach axes.

No AWS: everything here is pure, which is the reason the module exists
separately from the two handlers that consume it.
"""

import pytest

from shared.mcp_tokens import (
    ALL_READ_SCOPES,
    DEFAULT_READ_REACH,
    MCP_TOKEN_PK,
    REACH_KIND_PROJECT,
    REACH_KIND_WORKSPACE,
    REACH_NONE,
    REACH_PROJECT_SET,
    REACH_WORKSPACE,
    TOKEN_ID_PREFIX,
    TOKEN_PREFIX,
    VALID_READ_REACHES,
    VALID_SCOPES,
    hash_secret,
    mint_token,
    parse_token,
    reach_allows,
    secret_matches,
    token_sk,
)

# ===========================================================================
# Format: mint → parse round trip
# ===========================================================================

class TestMintAndParse:
    def test_minted_token_parses_back_to_its_own_id(self):
        """The whole point of the format: the id is recoverable from the token.

        This is what replaces "Query the project's token rows and hash each
        one" with a single keyed read, and therefore what removes the
        X-Project-Id header requirement.
        """
        minted = mint_token()
        parsed = parse_token(minted.raw)
        assert parsed is not None, f'freshly minted token did not parse: {minted.raw!r}'
        token_id, secret = parsed
        assert token_id == minted.token_id
        assert secret_matches(presented_secret=secret, stored_hash=minted.secret_hash)

    def test_raw_token_never_contains_the_stored_hash(self):
        """Only the secret half is hashed, and the hash is not in the credential."""
        minted = mint_token()
        assert minted.secret_hash not in minted.raw

    def test_token_id_is_in_the_credential_so_it_can_be_logged(self):
        minted = mint_token()
        assert minted.token_id in minted.raw
        assert minted.token_id.startswith(TOKEN_ID_PREFIX)
        assert minted.raw.startswith(TOKEN_PREFIX)

    def test_each_mint_is_unique(self):
        assert len({mint_token().raw for _ in range(50)}) == 50

    def test_secret_hash_is_stable_for_the_same_secret(self):
        assert hash_secret('abc') == hash_secret('abc')
        assert hash_secret('abc') != hash_secret('abd')


class TestParseRejectsMalformed:
    """A lenient parse would turn caller text into a DynamoDB key lookup.

    Revert story: loosening `parse_token` to split on the LAST underscore and
    accept whatever precedes it fails test_legacy_token_is_refused and
    test_wrong_part_count.
    """

    @pytest.mark.parametrize('raw', [
        '',
        'voc_',
        'voc',
        'nope_tok_' + 'a' * 16 + '_' + 'b' * 64,
        'voc_bad_' + 'a' * 16 + '_' + 'b' * 64,          # wrong id prefix
        'voc_tok_' + 'a' * 15 + '_' + 'b' * 64,          # id too short
        'voc_tok_' + 'a' * 17 + '_' + 'b' * 64,          # id too long
        'voc_tok_' + 'a' * 16 + '_' + 'b' * 63,          # secret too short
        'voc_tok_' + 'a' * 16 + '_' + 'b' * 65,          # secret too long
        'voc_tok_' + 'g' * 16 + '_' + 'b' * 64,          # id not hex
        'voc_tok_' + 'a' * 16 + '_' + 'g' * 64,          # secret not hex
        'voc_tok_' + 'A' * 16 + '_' + 'b' * 64,          # uppercase is not our format
        'voc_tok_' + 'a' * 16 + '_' + 'b' * 64 + '_x',   # extra part
    ])
    def test_wrong_part_count_or_alphabet_is_refused(self, raw):
        assert parse_token(raw) is None, f'{raw!r} must not parse'

    def test_legacy_token_is_refused(self):
        """`voc_<64 hex>` was the old format; it is deliberately not accepted.

        Owner decision 2026-08-18: no legacy tokens were in production use, and
        a stray one fails closed with a 401 that re-minting fixes. If this test
        ever needs deleting, that is a policy change, not a cleanup.
        """
        assert parse_token('voc_' + 'a' * 64) is None

    @pytest.mark.parametrize('raw', [None, 12345, b'voc_tok_x', ['voc_'], {}])
    def test_non_string_is_refused_not_raised(self, raw):
        """A non-string arrives from a header that something else mangled;
        it must be a refusal, not an AttributeError turning into a 500."""
        assert parse_token(raw) is None


class TestSecretMatches:
    def test_correct_secret_matches(self):
        assert secret_matches(presented_secret='s3cret', stored_hash=hash_secret('s3cret'))

    def test_wrong_secret_does_not_match(self):
        assert not secret_matches(presented_secret='s3cret', stored_hash=hash_secret('other'))

    def test_empty_stored_hash_does_not_match(self):
        assert not secret_matches(presented_secret='s3cret', stored_hash='')


# ===========================================================================
# Storage keys
# ===========================================================================

class TestStorageKeys:
    def test_token_rows_live_outside_any_project_partition(self):
        """A credential is workspace-level, so its partition is not a project's.

        This is also what keeps token rows invisible to projects.list_projects,
        which queries the TYPE#PROJECT GSI — these rows set no gsi1pk.
        """
        assert not MCP_TOKEN_PK.startswith('PROJECT#')
        assert token_sk('tok_abc').startswith('TOKEN#')

    def test_sk_is_derived_from_the_token_id(self):
        assert token_sk('tok_abc') == 'TOKEN#tok_abc'


# ===========================================================================
# Reach — the two axes
# ===========================================================================

class TestReachAllows:
    """The gate that decides whether a read is within a token's reach.

    Revert story: making the unrecognised-value fall-through return True
    (instead of the explicit False) fails
    test_unknown_reach_or_kind_is_refused.
    """

    def _allows(self, reach, kind, project_id='proj_a', projects=('proj_a',)):
        return reach_allows(
            read_reach=reach,
            token_projects=projects,
            tool_reach_kind=kind,
            project_id=project_id,
        )

    # --- workspace reach: the default, sees everything -------------------
    def test_workspace_reach_allows_workspace_shaped_reads(self):
        assert self._allows(REACH_WORKSPACE, REACH_KIND_WORKSPACE)

    def test_workspace_reach_allows_any_project_not_only_its_own(self):
        """The default really is workspace-wide — this is the whole point of
        the axis existing, and the reason the mint UI has to say so."""
        assert self._allows(REACH_WORKSPACE, REACH_KIND_PROJECT,
                            project_id='someone_elses', projects=('proj_a',))

    # --- project-set reach: the sealed option ---------------------------
    def test_project_set_reach_allows_a_project_in_the_set(self):
        assert self._allows(REACH_PROJECT_SET, REACH_KIND_PROJECT,
                            project_id='proj_a', projects=('proj_a', 'proj_b'))

    def test_project_set_reach_refuses_a_project_outside_the_set(self):
        assert not self._allows(REACH_PROJECT_SET, REACH_KIND_PROJECT,
                                project_id='proj_z', projects=('proj_a',))

    def test_project_set_reach_refuses_workspace_shaped_reads(self):
        """The load-bearing case. Feedback and metrics have no project
        dimension, so 'project-set' cannot narrow them — allowing them anyway
        would hand a supposedly sealed token the entire verbatim corpus."""
        assert not self._allows(REACH_PROJECT_SET, REACH_KIND_WORKSPACE)

    def test_project_set_reach_with_empty_set_reads_nothing(self):
        """A token with no projects and project-set reach is inert, not
        wide-open. This is exactly the trap that made remapping the old
        read-only tokens onto these axes unsafe."""
        assert not self._allows(REACH_PROJECT_SET, REACH_KIND_PROJECT, projects=())
        assert not self._allows(REACH_PROJECT_SET, REACH_KIND_WORKSPACE, projects=())

    # --- none: write-only credential ------------------------------------
    def test_none_reach_refuses_every_kind(self):
        assert not self._allows(REACH_NONE, REACH_KIND_WORKSPACE)
        assert not self._allows(REACH_NONE, REACH_KIND_PROJECT)

    # --- fail-closed ----------------------------------------------------
    @pytest.mark.parametrize('reach,kind', [
        ('nonsense', REACH_KIND_PROJECT),
        ('nonsense', REACH_KIND_WORKSPACE),
        (REACH_WORKSPACE, 'nonsense'),
        (REACH_PROJECT_SET, 'nonsense'),
        ('', ''),
    ])
    def test_unknown_reach_or_kind_is_refused(self, reach, kind):
        assert not self._allows(reach, kind)

    def test_project_shaped_read_without_a_project_is_refused(self):
        for reach in (REACH_WORKSPACE, REACH_PROJECT_SET):
            assert not self._allows(reach, REACH_KIND_PROJECT, project_id=None)
            assert not self._allows(reach, REACH_KIND_PROJECT, project_id='')


# ===========================================================================
# Vocabulary invariants
# ===========================================================================

class TestVocabulary:
    def test_default_reach_is_workspace_by_owner_decision(self):
        assert DEFAULT_READ_REACH == REACH_WORKSPACE
        assert DEFAULT_READ_REACH in VALID_READ_REACHES

    def test_the_full_read_set_is_exactly_the_vocabulary(self):
        """ALL_READ_SCOPES is a convenience, not a mint default.

        It must stay in step with VALID_SCOPES while every scope is a read; the
        day a write scope is added, this fails and forces a decision about
        whether "all read scopes" still means "all scopes".
        """
        assert set(ALL_READ_SCOPES) == VALID_SCOPES

    def test_no_scope_is_mintable_without_granting_something(self):
        """Guards against reintroducing a phantom permission.

        The previous model let `read-write` be minted, stored and badged while
        every tool required only `read`. Every scope in the vocabulary must be
        a read scope in this phase, because no write tool exists yet.
        """
        assert all(scope.endswith(':read') for scope in VALID_SCOPES), (
            'a non-read scope is mintable but no write tool exists to consult it — '
            'add the scope in the same change as the tool that requires it'
        )
