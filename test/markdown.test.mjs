import test from 'node:test';
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { parseMarkdown, parseInline, renderMarkdown, safeLink, MARKDOWN_LIMITS } from '../public/markdown.js';

class Node {
 constructor(tag = '#fragment', text = '') { this.tag = tag; this.text = text; this.children = []; this.attributes = {}; this.listeners = {}; }
 append(...nodes) { this.children.push(...nodes); }
 set textContent(value) { this.text = value; this.children = []; }
 get textContent() { return this.text + this.children.map(x => x.textContent).join(''); }
 setAttribute(key, value) { this.attributes[key] = value; }
 addEventListener(key, listener) { this.listeners[key] = listener; }
}
const document = { createDocumentFragment: () => new Node(), createElement: tag => new Node(tag), createTextNode: text => new Node('#text', text) };
const walk = node => [node, ...node.children.flatMap(walk)];

test('headings, paragraphs, lists, quotes and horizontal rules', () => {
 const ast = parseMarkdown('# Hello\n\nA **bold** `code` paragraph.\n\n- one\n- two\n\n3. third\n4. fourth\n\n> quotation\n\n---');
 assert.deepEqual(ast.map(x => x.type), ['heading','paragraph','list','list','quote','rule']);
 assert.equal(ast[0].level, 1); assert.equal(ast[2].items.length, 2); assert.equal(ast[3].start, 3);
 assert.deepEqual(ast[1].children.filter(x => x.type !== 'text').map(x => x.type), ['strong','code']);
});
test('closed and unclosed fenced code stays literal', () => {
 const ast = parseMarkdown('```js\n<script>alert(1)</script>\n**not bold**\n```\n\n~~~txt\nunfinished');
 assert.equal(ast.length, 2); assert.equal(ast[0].language, 'js'); assert.match(ast[0].text, /<script>/); assert.equal(ast[1].text, 'unfinished');
 const rendered = renderMarkdown(document, '```html\n<img src=x onerror=alert(1)>\n```');
 assert.equal(walk(rendered).filter(x => x.tag === 'img' || x.tag === 'script').length, 0);
 assert.match(rendered.textContent, /<img/);
});
test('raw HTML and images never become active content', () => {
 const rendered = renderMarkdown(document, '<script>alert(1)</script>\n\n![image](https://example.com/a.png)');
 assert.equal(walk(rendered).some(x => ['script','img','iframe'].includes(x.tag)), false);
 assert.equal(walk(rendered).filter(x => x.tag === 'a').length, 0);
 assert.match(rendered.textContent, /<script>/);
});
test('only credential-free absolute HTTP(S) URLs become links', () => {
 for (const url of ['javascript:alert(1)','data:text/html,x','file:///tmp/a','//evil.example','https://user:pass@example.com','https://a.example/\nfoo','\u0000https://a.example']) assert.equal(safeLink(url), null, url);
 assert.equal(safeLink('https://example.com/a?b=1'), 'https://example.com/a?b=1');
 const nodes = walk(renderMarkdown(document, '[safe](https://example.com) [unsafe](javascript:alert(1))'));
 const a = nodes.find(x => x.tag === 'a'); assert.equal(a.href, 'https://example.com/'); assert.equal(a.rel, 'noopener noreferrer'); assert.equal(a.target, '_blank'); assert.equal(nodes.filter(x => x.tag === 'a').length, 1);
});
test('tables support bounded cells, escaped pipes, alignment and inline formatting', () => {
 const ast = parseMarkdown('| **Name** | Value |\n| :--- | ---: |\n| a\\|b | `42` |');
 assert.equal(ast[0].type, 'table'); assert.deepEqual(ast[0].align, ['left','right']); assert.equal(ast[0].rows[0][0][0].text, 'a|b');
 const nodes = walk(renderMarkdown(document, '| A | B |\n| --- | --- |\n| 1 | 2 |')); assert.equal(nodes.filter(x => x.tag === 'th').length, 2); assert.equal(nodes.filter(x => x.tag === 'td').length, 2);
});
test('escape tokens and nested emphasis/link labels remain safe', () => {
 const tokens = parseInline('\\*literal\\* **[site](https://example.com)**');
 assert.equal(tokens.map(x => x.type).includes('strong'), true); assert.equal(tokens.find(x => x.type === 'strong').children[0].type, 'link');
});
test('copy performs no action until click and honestly reports failure', async () => {
 let calls = 0; const root = renderMarkdown(document, '```js\nhello\n```', {onCopy:async text => {calls++; assert.equal(text, 'hello');}}); const copy = walk(root).find(x => x.tag === 'button');
 assert.equal(calls,0); await copy.listeners.click(); assert.equal(calls,1); assert.equal(copy.textContent,'已复制'); assert.equal(copy.disabled,false);
 const failed = walk(renderMarkdown(document, '```\nx\n```', {onCopy:async()=>{throw new Error('denied');}})).find(x => x.tag === 'button'); await failed.listeners.click(); assert.match(failed.textContent,/失败/);
});
test('block, character, depth and rendered-node limits are enforced', () => {
 const ast = parseMarkdown('# one\n\n'.repeat(1000)); assert.ok(ast.length <= MARKDOWN_LIMITS.blocks + 1); assert.match(ast.at(-1).children[0].text,/截断/);
 const long = parseMarkdown('x'.repeat(MARKDOWN_LIMITS.chars+1)); assert.match(long.at(-1).children[0].text,/截断/);
 const nested = renderMarkdown(document, '> > > > > > deeply quoted'); assert.ok(walk(nested).length < 30);
 const table = '|a|b|c|d|e|f|g|h|i|j|k|l|\n|---|---|---|---|---|---|---|---|---|---|---|---|\n' + '|1|\n'.repeat(100);
 const result = renderMarkdown(document, (table+'\n').repeat(100)); assert.ok(walk(result).length <= MARKDOWN_LIMITS.nodes+3);
});
test('adversarial unmatched inline markers finish within a generous CPU budget', () => {
 const started=performance.now();
 for(const char of ['[','`','*','_','\\','<','('])parseMarkdown(char.repeat(MARKDOWN_LIMITS.chars));
 parseMarkdown('[a]('.repeat(5000)+'C:/x'+')'.repeat(5000));
 assert.ok(performance.now()-started<3000, 'bounded input should not hang');
});
test('Chinese, space and Windows local paths become file controls, never navigation', () => {
 const tokens = parseInline('[sample.md](C:/Users/TestUser/demo-project/sample.md)');
 assert.equal(tokens.length, 1); assert.equal(tokens[0].type, 'file');
 assert.equal(tokens[0].ref.fullPath, 'C:/Users/TestUser/demo-project/sample.md');
 const cases = [
  ['[a](<C:\\Program Files\\My App\\a b.js>)', 'C:\\Program Files\\My App\\a b.js', null],
  ['[z](C:/Program Files (x86)/z.txt:42)', 'C:/Program Files (x86)/z.txt', 42],
  ['[e](C:/a/%E4%B8%AD%E6%96%87.md#L7-L9)', 'C:/a/中文.md', 7],
  ['[u](\\\\server\\share\\x.log)', '\\\\server\\share\\x.log', null],
  ['[p](/home/me/notes.md#L3C2)', '/home/me/notes.md', 3],
  ['[f](file:///C:/a/b.txt)', 'C:/a/b.txt', null],
  ['<D:\\代码\\项目 一\\README.md>', 'D:\\代码\\项目 一\\README.md', null],
 ];
 for (const [source, path, line] of cases) { const file = parseInline(source).find(t => t.type === 'file'); assert.ok(file, source); assert.equal(file.ref.fullPath, path, source); assert.equal(file.ref.line, line, source); }
 const relative = parseInline('[app](public/app.js:10)', { cwd: 'C:\\Users\\TestUser\\demo-project' })[0];
 assert.equal(relative.ref.fullPath, 'C:\\Users\\TestUser\\demo-project\\public\\app.js'); assert.equal(relative.ref.location, ':10');
});
test('dangerous schemes and non-path destinations stay literal text', () => {
 for (const url of ['javascript:alert(1)', 'vbscript:msgbox', 'data:text/html,x', 'shell:startup', 'ms-settings:privacy', 'cmd:/c calc', 'powershell:x', 'file://server/share', '#anchor', 'plainword', 'C:/a\u0000b.md']) {
  const tokens = parseInline(`[x](${url})`);
  assert.ok(tokens.every(t => t.type === 'text'), url);
 }
});
test('local file controls are buttons that never set href and call the supplied handler', async () => {
 const seen = []; const root = renderMarkdown(document, '打开 [规范](C:/文档/规范 v2.md#L12)', { onLocalLink: ref => seen.push(ref) });
 const nodes = walk(root); assert.equal(nodes.filter(x => x.tag === 'a').length, 0);
 const button = nodes.find(x => x.tag === 'button'); assert.equal(button.className, 'md-file-link'); assert.equal(button.type, 'button');
 assert.equal(button.attributes['data-path'], 'C:/文档/规范 v2.md'); assert.equal(button.attributes['data-line'], '12');
 assert.match(button.textContent, /规范:12/); assert.equal(button.href, undefined);
 await button.listeners.click({ preventDefault() {} }); assert.equal(seen.length, 1); assert.equal(seen[0].line, 12);
 let copied = ''; const fallback = walk(renderMarkdown(document, '<C:\\a b\\c.md>', { onCopy: async text => { copied = text; } })).find(x => x.tag === 'button');
 await fallback.listeners.click({ preventDefault() {} }); assert.equal(copied, 'C:\\a b\\c.md');
});
test('lists keep indented continuation lines in the same item', () => {
 const ast = parseMarkdown('- first\n  continued\n- second');
 assert.equal(ast[0].items.length, 2); assert.match(ast[0].items[0].map(t => t.text).join(''), /first\ncontinued/);
});
