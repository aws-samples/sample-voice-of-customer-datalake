"""The harness's entry script in every image: ``/usr/bin/python3 -I /opt/voc/harness.py <command> ...``.

``-I`` (isolated): no PYTHON* variable, no user site, and not even this script's directory on the path, so
the one directory put there is this script's own (root-owned /opt/voc, where the image copies the
engineering package): never the checkout or a directory repository code can write.
"""
import importlib
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
importlib.import_module('engineering.runtime.harness.main').entry()
