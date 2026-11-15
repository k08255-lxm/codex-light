import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
test('fresh installer exposes current brand while preserving the legacy detection identity',()=>{
 const source=readFileSync(new URL('../desktop/velopack/setup-wrapper/Program.cs',import.meta.url),'utf8');
 assert.equal((source.match(/Codex Light/g)||[]).length,1);
 assert.ok(source.includes('title.StartsWith("Codex Light",StringComparison.OrdinalIgnoreCase)'));
 assert.ok(source.includes('Text="安装 码舱 CodeCang"'));
 assert.equal((source.match(/码舱 CodeCang/g)||[]).length,6);
 assert.ok(source.includes('"CodexLight.SetupWrapper."'));
 assert.ok(source.includes('"CodexLightDesktop"'));
});
