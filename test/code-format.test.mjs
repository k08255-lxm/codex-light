import test from 'node:test';
import assert from 'node:assert/strict';
import {createDocument} from './mini-dom.mjs';
import {createConsoleCode,updateConsoleCode,syntaxParts} from '../public/code-format.js';
import {renderMarkdown} from '../public/markdown.js';

test('code and terminal formatting emits bounded, literal text nodes',()=>{
 const document=createDocument();
 const value='const n = 42; // <img onerror=alert(1)>';
 const fence=renderMarkdown(document,'```js\n'+value+'\n```');
 const code=fence.querySelector('code');assert.equal(code.textContent,value);
 assert.equal(code.querySelector('.syntax-keyword').textContent,'const');
 assert.equal(code.querySelector('.syntax-number').textContent,'42');
 assert.equal(code.querySelectorAll('img').length,0);
 assert.equal(syntaxParts('const x;'.repeat(5000),'js'),null);
 assert.equal(syntaxParts('func var','arbitrary-markup'),null);
 const output=createConsoleCode(document,'step-output','\x1b[31mERROR\x1b[0m <script>ignored()</script>');
 assert.equal(output.textContent,'ERROR <script>ignored()</script>');
 assert.equal(output.querySelector('.syntax-error').textContent,'ERROR');assert.equal(output.querySelectorAll('script').length,0);
 const original=output.querySelector('code');updateConsoleCode(output,'ERROR <script>ignored()</script>');assert.equal(output.querySelector('code'),original);
});
