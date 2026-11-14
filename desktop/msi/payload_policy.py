"""Conservative MSI-only filtering for the locked DSH runtime dependencies."""
from pathlib import PurePosixPath
import re

DEPENDENCY_PREFIX = 'app/components/dsh-bridge/node_modules/'


def omitted_runtime_file(relative_path):
    """Drop TypeScript declarations only, never executable code or source maps.

    The installed bridge executes JavaScript with Node, not TypeScript tooling.
    Keep package.json/exports, all JS, ordinary TS source, resources, licenses,
    tests and JS source maps. This is deliberately not a generic npm prune rule.
    """
    if not relative_path.startswith(DEPENDENCY_PREFIX):
        return False
    name = PurePosixPath(relative_path).name.lower()
    if any(word in name for word in ('license', 'licence', 'notice', 'copying')):
        return False
    return re.search(r'\.d\.(?:ts|mts|cts)(?:\.map)?$', name) is not None