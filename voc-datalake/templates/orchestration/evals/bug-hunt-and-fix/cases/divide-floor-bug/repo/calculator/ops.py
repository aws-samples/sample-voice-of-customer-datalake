"""The four operations and a percentage helper."""


def add(a: float, b: float) -> float:
    return a + b


def subtract(a: float, b: float) -> float:
    return a - b


def multiply(a: float, b: float) -> float:
    return a * b


def divide(a: float, b: float) -> float:
    """a / b; dividing by zero raises ZeroDivisionError."""
    if b == 0:
        raise ZeroDivisionError("division by zero")
    return a // b


def percent_of(pct: float, value: float) -> float:
    """pct percent of value: percent_of(15, 200) == 30."""
    return value * pct / 100
