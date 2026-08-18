"""Shared token utilities."""
import hashlib


def hash_token(token: str) -> str:
    """Hash a token using SHA-256 for secure storage/comparison."""
    return hashlib.sha256(token.encode()).hexdigest()
