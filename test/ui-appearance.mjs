// Run with Playwright on NODE_PATH and, optionally, CHROMIUM_PATH set to a local browser.
// Uses an isolated local DemoClient and writes screenshots into .tmp/ui-appearance.
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DemoClient } from '../src/demo.mjs';
import { createServer } from '../src/server.mjs';

const { chromium } = createRequire(import.meta.url)('playwright');
const screenshots = path.resolve('.tmp/ui-appearance');
await mkdir(screenshots, { recursive: true });
const workspace = await mkdtemp(path.join(tmpdir(), 'codecang-appearance-'));
const client = new DemoClient();
let app, browser;
try {
  app = await createServer({
    client, demo: true, cwd: workspace, projectsRoot: path.join(workspace, 'projects'),
    desktopStateRoot: path.join(workspace, 'desktop'), fileAttachmentRoot: path.join(workspace, 'files'),
    storageRoot: path.join(workspace, 'storage'), statisticsRoot: path.join(workspace, 'stats'),
  });
  await app.started;
  browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_PATH });
  const page = await browser.newPage({ viewport: { width: 1250, height: 850 }, reducedMotion: 'reduce' });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(app.url);
  await page.locator('#connection-text').filter({hasText: '演示模式'}).waitFor();
  await page.locator('#prompt').fill('检查会话配色');
  await page.locator('#prompt').press('Enter');
  await page.locator('.message-bubble').first().waitFor();
  await page.locator('.markdown-body').filter({hasText: /./}).first().waitFor();

  async function appearanceSettings() {
    await page.locator('#rail-settings').click();
    await page.locator('[data-settings-section="appearance"]').click();
  }
  const rgb = hex => 'rgb(' + hex.match(/../g).map(channel => parseInt(channel, 16)).join(', ') + ')';
  for (const [style, theme, colors] of [
    // Canvas, sidebar, composer, user bubble, text.
    ['codex', 'dark',  ['18191a','151617','1f2021','262829','cfd0d1']],
    ['codex', 'light', ['fcfcfd','f3f5f7','ffffff','edf0f4','232931']],
    ['dsh',   'light', ['ffffff','f9fafb','ffffff','edf3fe','0f1115']],
    ['dsh',   'dark',  ['151517','1b1b1c','2c2c2e','2c2c2e','f9fafb']],
  ]) {
    await appearanceSettings();
    await page.locator(`[data-style-choice="${style}"]`).click();
    await page.locator(`[data-theme-choice="${theme}"]`).click();
    assert.equal(await page.locator(`[data-style-choice="${style}"]`).getAttribute('aria-pressed'), 'true');
    await page.locator('#rail-home').click();
    const actual = await page.evaluate(() => {
      const css = selector => getComputedStyle(document.querySelector(selector));
      return [css('body').backgroundColor, css('.sidebar').backgroundColor, css('.composer').backgroundColor,
        css('.message-bubble').backgroundColor, css('.message-bubble').color];
    });
    assert.deepEqual(actual, colors.map(rgb), style + ' ' + theme);
    if (style === 'dsh') {
      await page.locator('#prompt').click();
      const focus = await page.locator('.composer').evaluate(el => {
        const css = getComputedStyle(el);
        return [css.borderTopColor, css.borderTopWidth, css.boxShadow];
      });
      assert.deepEqual(focus, ['rgb(127, 130, 135)', '1px', 'none'], 'single neutral input border');
    }
    await page.screenshot({ path: path.join(screenshots, style + '-' + theme + '.png') });
    console.log('PASS', style, theme, 'chat');
  }
  await page.reload();
  await appearanceSettings();
  for (const selector of ['[data-style-choice="dsh"]', '[data-theme-choice="dark"]']) {
    assert.equal(await page.locator(selector).getAttribute('aria-pressed'), 'true', 'choice restores on reload');
  }
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.locator('[data-style-choice]').evaluateAll(buttons => buttons.every(button => {
    const rect = button.getBoundingClientRect();
    return rect.width > 0 && rect.left >= 0 && rect.right <= innerWidth;
  })), true, 'all appearance choices fit at 390px');
  await page.screenshot({ path: path.join(screenshots, 'mobile-picker.png') });
  await page.locator('[data-style-choice="codex"]').click();
  await page.evaluate(() => { document.documentElement.dataset.mobileShell = 'android'; });
  await page.locator('#rail-home').click();
  await page.locator('#model-trigger').click();
  await page.locator('#model-list-open').click();
  await page.locator('.model-option').filter({hasText: '演示六档模型'}).click();
  await page.locator('#reasoning-range').focus();
  await page.keyboard.press('Home');
  for (let step = 0; step < 3; step++) await page.keyboard.press('ArrowRight');
  assert.equal(await page.locator('#effort').inputValue(), 'xhigh');
  await page.locator('#reasoning-range').blur();
  for (const width of [320, 390]) {
    await page.setViewportSize({width, height: 844});
    const layout = await page.evaluate(() => {
      const rect = id => document.getElementById(id).getBoundingClientRect();
      const dialog = rect('reasoning-popover'), model = rect('model-list-open');
      const effort = rect('reasoning-label'), range = rect('reasoning-range');
      return {
        fits: dialog.left >= 0 && dialog.right <= innerWidth,
        sameRow: model.right <= effort.left + 1 && Math.abs((model.top + model.bottom - effort.top - effort.bottom) / 2) < 2,
        targetHeight: Math.min(range.height, model.height, rect('reasoning-reset').height),
        modelFont: parseFloat(getComputedStyle(document.getElementById('model-list-open')).fontSize)
      };
    });
    assert.ok(layout.fits && layout.sameRow && layout.targetHeight >= 44 && layout.modelFont >= 14,
      'Android reasoning selector at ' + width + 'px ' + JSON.stringify(layout));
  }
  await page.screenshot({path: path.join(screenshots, 'android-reasoning-dark.png')});
  await page.locator('#model-list-open').click();
  await page.locator('#model-list-back').click();
  assert.equal(await page.locator('#reasoning-range').isVisible(), true);
  assert.deepEqual(errors, []);
  console.log('PASS refresh, appearance picker and Android reasoning controls at 320px and 390px');
} finally {
  await browser?.close();
  await app?.close();
  client.close();
  await rm(workspace, { recursive: true, force: true });
}
