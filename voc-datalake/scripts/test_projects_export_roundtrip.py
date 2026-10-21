"""Regression tests for the projects export/import Decimal round-trip.

The data risk in the export bundle is numeric precision: DynamoDB stores numbers
as Decimal, JSON has only binary floats, and DynamoDB rejects floats on write.
`export_projects.DecimalEncoder` and `import_projects._reconstruct_decimals`
together must preserve every number EXACTLY. These tests would fail if either
side regressed to routing values through float.
"""
import importlib.util
import json
import pathlib
from decimal import Decimal


def _load(name):
    spec = importlib.util.spec_from_file_location(
        name, pathlib.Path(__file__).with_name(f"{name}.py")
    )
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


_exp = _load("export_projects")
_imp = _load("import_projects")


def _roundtrip(item: dict) -> dict:
    line = json.dumps(item, cls=_exp.DecimalEncoder)
    return _imp._reconstruct_decimals(json.loads(line))


class TestDecimalRoundTrip:
    def test_non_integral_decimal_is_preserved_exactly(self):
        out = _roundtrip({"avg_sentiment": Decimal("-0.55")})
        assert out["avg_sentiment"] == Decimal("-0.55")
        assert isinstance(out["avg_sentiment"], Decimal)

    def test_high_precision_decimal_does_not_drift(self):
        # 0.333333 is not representable in binary float; the sentinel keeps it exact.
        out = _roundtrip({"score": Decimal("0.333333")})
        assert out["score"] == Decimal("0.333333")

    def test_integral_decimal_survives_as_a_number(self):
        out = _roundtrip({"persona_count": Decimal("3")})
        assert out["persona_count"] == 3

    def test_decimals_nested_in_lists_and_maps_are_reconstructed(self):
        out = _roundtrip({"nested": {"q": [Decimal("1"), Decimal("2.5")]}})
        assert out["nested"]["q"] == [1, Decimal("2.5")]

    def test_non_numeric_values_pass_through_untouched(self):
        item = {"pk": "PROJECT#p1", "sk": "META", "name": "Ann", "tags": ["a", "b"]}
        assert _roundtrip(item) == item

    def test_a_realistic_persona_item_round_trips_identically(self):
        item = {
            "pk": "PROJECT#p1",
            "sk": "PERSONA#x",
            "persona_count": Decimal("3"),
            "avg_sentiment": Decimal("-0.55"),
            "avatar_url": "s3://bucket/avatars/x.jpeg",
            "quotes": ["I want faster checkout"],
            "identity": {"age": Decimal("42")},
        }
        assert _roundtrip(item) == item


class TestReconstructGuards:
    def test_stray_float_is_coerced_to_decimal(self):
        # The exporter never emits bare floats, but a hand-edited bundle might —
        # DynamoDB rejects floats, so the importer must coerce rather than fail.
        assert _imp._reconstruct_decimals(1.5) == Decimal("1.5")
        assert isinstance(_imp._reconstruct_decimals(1.5), Decimal)
