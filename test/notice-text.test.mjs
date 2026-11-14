import test from 'node:test';import assert from 'node:assert/strict';
import {collectNoticeText,readNoticeText} from '../src/notice-text.mjs';
test('notice text preserves distinct copyrights, UTF8, CRLF and identical source aliases',()=>{
 const a=Buffer.from('Copyright Alice\r\nMIT鍏ㄦ枃\r\n'),b=Buffer.from('Copyright Bob\nMIT鍏ㄦ枃\n');
 const input={'a/LICENSE':a,'b/NOTICE':b,'c/LICENSE':a},packed=collectNoticeText(input),out=readNoticeText(packed);
 assert.deepEqual(Object.keys(out),Object.keys(input));for(const n in input)assert.deepEqual(out[n],input[n]);
 assert.equal(packed.toString().split('Copyright Alice').length-1,1);assert.ok(packed.includes(b));
});
test('notice text rejects invalid paths, nontext, empty text, duplicate case and tampering',()=>{
 for(const input of [{'../escape':Buffer.from('x')},{'C:/x':Buffer.from('x')},{a:Buffer.from([255])},{a:Buffer.alloc(0)},{A:Buffer.from('x'),a:Buffer.from('x')}])assert.throws(()=>collectNoticeText(input));
 const b=collectNoticeText({LICENSE:Buffer.from('Copyright remains')});b[b.length-1]^=1;assert.throws(()=>readNoticeText(b));
});
