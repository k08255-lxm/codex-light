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

  // Keep the actual xterm renderer alive across all preference changes without starting a shell.
  const terminal = await page.evaluateHandle(async () => {
    const { mountTerminal } = await import('/terminal.js');
    const container = document.createElement('div');
    container.id = 'appearance-terminal';
    container.className = 'terminal-container';
    Object.assign(container.style, { position: 'fixed', left: '-1200px', width: '600px', height: '300px' });
    document.body.append(container);
    return mountTerminal({ container, status: document.createElement('div'), subscribe: () => () => {},
      api() { throw new Error('Appearance test tried to operate a shell'); } });
  });
  async function appearanceSettings() {
    await page.locator('#rail-settings').click();
    await page.locator('[data-settings-section="appearance"]').click();
  }
  const rgb = hex => 'rgb(' + hex.match(/../g).map(channel => parseInt(channel, 16)).join(', ') + ')';
  for (const [style, theme, colors] of [
    // Canvas, sidebar, composer, user bubble, text, terminal background.
    ['codex', 'dark',  ['1a1d22','171a1e','22262c','292f37','e4e8ee','1f2329']],
    ['codex', 'light', ['fcfcfd','f3f5f7','ffffff','edf0f4','232931','f3f5f7']],
    ['dsh',   'light', ['ffffff','f9fafb','ffffff','edf3fe','0f1115','ffffff']],
    ['dsh',   'dark',  ['151517','1b1b1c','2c2c2e','2c2c2e','f9fafb','151517']],
  ]) {
    await appearanceSettings();
    await page.locator(`[data-style-choice="${style}"]`).click();
    await page.locator(`[data-theme-choice="${theme}"]`).click();
    assert.equal(await page.locator(`[data-style-choice="${style}"]`).getAttribute('aria-pressed'), 'true');
    await page.locator('#rail-home').click();
    const actual = await page.evaluate(() => {
      const css = selector => getComputedStyle(document.querySelector(selector));
      return [css('body').backgroundColor, css('.sidebar').backgroundColor, css('.composer').backgroundColor,
        css('.message-bubble').backgroundColor, css('.message-bubble').color,
        css('#appearance-terminal .xterm-viewport').backgroundColor,
        css('#appearance-terminal .xterm [style*="background-color"]').backgroundColor];
    });
    assert.deepEqual(actual, [...colors, colors.at(-1)].map(rgb), style + ' ' + theme);
    if (style === 'dsh') {
      await page.locator('#prompt').click();
      const focus = await page.locator('.composer').evaluate(el => {
        const css = getComputedStyle(el);
        return [css.borderTopColor, css.borderTopWidth, css.boxShadow];
      });
      assert.deepEqual(focus, ['rgb(127, 130, 135)', '1px', 'none'], 'single neutral input border');
    }
    await page.screenshot({ path: path.join(screenshots, style + '-' + theme + '.png') });
    console.log('PASS', style, theme, 'chat and mounted terminal');
  }
  await terminal.evaluate(view => view.dispose());
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
  assert.deepEqual(errors, []);
  console.log('PASS refresh and 390px appearance picker');
} finally {
  await browser?.close();
  await app?.close();
  client.close();
  await rm(workspace, { recursive: true, force: true });
}
