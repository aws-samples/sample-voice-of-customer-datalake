"""Session-wide pytest hooks for both test trees (lambda/ and plugins/).

Kept to hooks only: per-tree environment and fixtures live in
lambda/conftest.py and plugins/conftest.py.
"""
import socket
import sys


def close_xray_emitter_socket() -> bool:
    """Close the UDP socket the X-Ray SDK's global recorder opened, if it exists.

    Importing ``aws_xray_sdk.core`` builds ``xray_recorder``, whose ``UDPEmitter``
    opens a datagram socket for the daemon and never closes it (the SDK has no
    close). In Lambda the process just ends; in a test session the interpreter
    reports it at exit as ``ResourceWarning: unclosed <socket.socket ... type=2>``.
    Nothing is imported here: a session that never loaded the SDK has no socket.

    Returns whether a socket was closed.
    """
    core = sys.modules.get('aws_xray_sdk.core')
    recorder = getattr(core, 'xray_recorder', None)
    emitter = getattr(recorder, 'emitter', None)
    udp_socket = getattr(emitter, '_socket', None)
    if not isinstance(udp_socket, socket.socket) or udp_socket.fileno() == -1:
        return False
    udp_socket.close()
    return True


def pytest_unconfigure() -> None:
    """Release process-wide resources the suite opened, once every test has run.

    Takes no ``config``: pluggy lets a hook implementation accept a subset of the
    spec's arguments, and this one needs none.
    """
    close_xray_emitter_socket()
