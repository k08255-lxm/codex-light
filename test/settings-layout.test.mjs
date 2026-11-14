import test from 'node:test';import assert from 'node:assert/strict';import {readFileSync} from 'node:fs';
const read=p=>readFileSync(new URL('../'+p,import.meta.url),'utf8');
test('DSH settings are an independent section, not a scroll alias',()=>{
 const html=read('public/index.html'),app=read('public/app.js');
 const general=html.slice(html.indexOf('<section id="settings-general"'),html.indexOf('<section id="settings-dsh"'));
 assert.ok(!general.includes('dsh-connection-root'));assert.ok(!general.includes('settings-dsh-heading'));
 const dsh=html.slice(html.indexOf('<section id="settings-dsh"'),html.indexOf('<section id="settings-appearance"'));
 assert.ok(dsh.includes('dsh-connection-root')&&dsh.includes('dsh-config-root'));
 assert.ok(!app.includes("section === 'dsh' ? 'general'"));assert.ok(app.includes("page === 'dsh' && !state.lan"));
});
test('close dialog owns logical font and measures content instead of clipping fixed-width actions',()=>{
 const source=read('desktop/CloseChoiceDialog.cs');assert.ok(source.includes('9f,FontStyle.Regular,GraphicsUnit.Point'));
 assert.ok(source.includes('AutoSizeMode.GrowAndShrink'));assert.ok(!source.includes('ClientSize=new Size(468,152)'));
 assert.ok(!read('desktop/MainWindow.cs').includes('CloseChoiceDialog(BackColor,ForeColor,Font)'));
 assert.ok(source.includes('AcceptButton=cancel'));assert.ok(source.includes('SystemInformation.HighContrast'));
});
