import unittest
from payload_policy import omitted_runtime_file


class PayloadPolicyTests(unittest.TestCase):
    def test_only_dependency_declarations_are_removed(self):
        base = 'app/components/dsh-bridge/node_modules/pkg/'
        for name in ('index.d.ts', 'index.d.mts', 'index.d.cts', 'index.d.ts.map', 'index.d.mts.map'):
            self.assertTrue(omitted_runtime_file(base + name), name)
        for name in ('index.js', 'index.mjs', 'index.cjs', 'index.ts', 'index.js.map',
                     'package.json', 'LICENSE', 'NOTICE.d.ts', 'COPYING.d.ts.map',
                     'test.js', 'src/runtime.ts', 'asset.json', 'binary.node'):
            self.assertFalse(omitted_runtime_file(base + name), name)

    def test_other_payload_scopes_are_untouched(self):
        for path in ('app/public/index.d.ts', 'app/src/index.d.ts', 'licenses/file.d.ts',
                     'app/components/dsh-bridge/src/index.d.ts', 'node_modules/pkg/index.d.ts'):
            self.assertFalse(omitted_runtime_file(path), path)


if __name__ == '__main__':
    unittest.main()