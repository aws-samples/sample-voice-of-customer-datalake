"""The stock count of a store's shelves."""


def restock_needed(counts: dict[str, int], minimum: int) -> list[str]:
    """The shelves holding fewer than minimum items, by name."""
    return sorted(shelf for shelf, count in counts.items() if count < minimum)
