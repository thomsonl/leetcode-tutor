// End-to-end check of the Changelog tab and of the notice an update leaves,
// in the REAL unpacked extension (Playwright's cached Chromium).
//
// The browser's own update cannot be staged here, so the note an update
// leaves (shared/update-notice.js, in storage.local) is written the way the
// worker writes it. Checked: the tab and what it lists, the Tutor tab's row
// (What's new, Dismiss), the toolbar badge through the real chrome.action API,
// and that opening the Changelog counts as seeing the update everywhere.
//
// Run with:  node extension/e2e/update-notice.e2e.mjs
// Screenshots land in $LC_E2E_SHOTS (default /tmp/lc-update-shots).

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { extensionCopy, launch } from './cdp.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const extensionDir = path.resolve(here, '..');
const shots = process.env.LC_E2E_SHOTS || '/tmp/lc-update-shots';
fs.mkdirSync(shots, { recursive: true });
const manifest = JSON.parse(fs.readFileSync(path.join(extensionDir, 'manifest.json'), 'utf8'));
const changelog = JSON.parse(fs.readFileSync(path.join(extensionDir, 'changelog.json'), 'utf8'));
const fixture = fs.readFileSync(path.join(here, 'panel-fixture.html'), 'utf8');

const results = [];
async function scenario(name, fn) {
  try {
    await fn();
    results.push({ name, ok: true });
    console.log(`ok   ${name}`);
  } catch (err) {
    results.push({ name, ok: false });
    console.log(`FAIL ${name}\n     ${err.message}`);
  }
}
const check = (condition, message) => {
  if (!condition) throw new Error(message);
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const copy = extensionCopy(extensionDir, {});
const browser = await launch({ extensionDir: copy.dir });
try {
  const stored = () => browser.serviceWorkerEval(`chrome.storage.local.get('updateNotice').then((s) => s.updateNotice || null)`);
  const badge = () => browser.serviceWorkerEval(`chrome.action.getBadgeText({})`);
  const writeNote = (note) => browser.serviceWorkerEval(`chrome.storage.local.set({ updateNotice: ${JSON.stringify(note)} })`);

  async function openOptions(hash = '') {
    const page = await browser.openPage('about:blank');
    await page.failFetch('http://localhost:8135/*');
    await page.send('Emulation.setDeviceMetricsOverride', { width: 1100, height: 900, deviceScaleFactor: 1, mobile: false });
    await page.send('Page.navigate', { url: `chrome-extension://${browser.extensionId}/settings.html${hash}` });
    await page.waitFor(`document.getElementById('tab-changelog') && document.readyState === 'complete'`, { what: 'the options page' });
    return page;
  }
  const helpers = `(() => {
    window.__root = () => document.getElementById('lc-tutor-panel-host').shadowRoot;
    window.__q = (sel) => window.__root().querySelector(sel);
    window.__openTutor = () => document.querySelector('[data-lc-tutor-tab]').dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0 }));
  })()`;
  async function openProblem() {
    const tab = await browser.openPage('about:blank');
    await tab.send('Fetch.enable', { patterns: [{ urlPattern: 'https://leetcode.com/*' }, { urlPattern: 'http://localhost:8135/*' }] });
    tab.on('Fetch.requestPaused', async (p) => {
      const url = new URL(p.request.url);
      if (url.host === 'localhost:8135') return void (await tab.send('Fetch.failRequest', { requestId: p.requestId, errorReason: 'ConnectionRefused' }));
      const isPage = url.pathname.startsWith('/problems/');
      await tab.send('Fetch.fulfillRequest', {
        requestId: p.requestId,
        responseCode: isPage ? 200 : 404,
        responseHeaders: [{ name: 'Content-Type', value: 'text/html; charset=utf-8' }],
        body: Buffer.from(isPage ? fixture : '').toString('base64'),
      });
    });
    await tab.send('Emulation.setDeviceMetricsOverride', { width: 1100, height: 760, deviceScaleFactor: 1, mobile: false });
    await tab.send('Page.navigate', { url: 'https://leetcode.com/problems/two-sum/description/' });
    await tab.waitFor(`document.readyState === 'complete'`, { what: 'the problem page' });
    await tab.eval(helpers);
    await tab.send('Page.bringToFront');
    await tab.waitFor(`document.querySelector('[data-lc-tutor-tab]')`, { what: 'the Tutor tab' });
    await tab.eval('window.__openTutor()');
    await tab.waitFor(`window.__q('.update')`, { what: 'the panel' });
    return tab;
  }

  await scenario('the Changelog tab sits after Settings and lists the shipped releases, newest first', async () => {
    const page = await openOptions('#changelog');
    await page.waitFor(`document.querySelector('.release')`, { what: 'the releases' });
    const ui = await page.eval(`(() => ({
      tabs: [...document.querySelectorAll('.tab')].map((t) => t.textContent + (t.getAttribute('aria-selected') === 'true' ? '*' : '')).join(' | '),
      sub: document.getElementById('page-sub').textContent,
      version: document.getElementById('changelog-version').textContent,
      releases: [...document.querySelectorAll('.release')].map((r) => r.dataset.version + (r.querySelector('.tag') ? ' (current)' : '')),
      bullets: document.querySelectorAll('.release li').length,
      hash: location.hash,
      connectionHidden: getComputedStyle(document.getElementById('connection')).display === 'none',
      settingsHidden: document.getElementById('panel-settings').hidden,
      text: document.getElementById('panel-changelog').textContent,
    }))()`);
    check(ui.tabs === 'Progress | Settings | Changelog*', ui.tabs);
    check(ui.sub === "What's new" && ui.version === `You are on version ${manifest.version}.`, JSON.stringify(ui));
    const shipped = changelog.releases.filter((r) => r.version <= manifest.version).map((r) => r.version);
    check(JSON.stringify(ui.releases.map((r) => r.split(' ')[0])) === JSON.stringify(shipped), `releases ${ui.releases} vs ${shipped}`);
    check(ui.releases[0].endsWith('(current)') && ui.releases.slice(1).every((r) => !r.includes('current')), ui.releases.join());
    check(!ui.releases.some((r) => r.startsWith('1.4.0')) || manifest.version >= '1.4.0', 'a release that has not shipped stays hidden');
    check(ui.hash === '#changelog' && ui.settingsHidden && ui.connectionHidden, JSON.stringify(ui));
    check(!/[–—]/.test(ui.text) && ui.bullets > 5, 'no dashes, real content');
    // Left and right arrows, Home and End move between the three tabs.
    await page.eval(`document.getElementById('tab-changelog').focus()`);
    await page.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Home', code: 'Home', windowsVirtualKeyCode: 36 });
    await page.waitFor(`document.getElementById('tab-progress').getAttribute('aria-selected') === 'true'`, { what: 'Home to reach Progress' });
    await page.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'End', code: 'End', windowsVirtualKeyCode: 35 });
    await page.waitFor(`document.getElementById('tab-changelog').getAttribute('aria-selected') === 'true'`, { what: 'End to reach Changelog' });
    await page.screenshot(path.join(shots, 'changelog-tab.png'), { width: 1100, height: 900 });
    page.close();
  });

  await scenario('with no update to see: no badge, no row in the Tutor tab', async () => {
    check((await badge()) === '', `badge: ${JSON.stringify(await badge())}`);
    const tab = await openProblem();
    await wait(400);
    check(await tab.eval(`window.__q('.update').hidden`), 'the row is hidden');
    tab.close();
  });

  await scenario('an update leaves a NEW badge (through the real action API) and a row in the Tutor tab', async () => {
    await writeNote({ from: '1.2.0', to: manifest.version });
    // The worker starts again (an extension reload, like a browser restart,
    // gives it a fresh start) and puts the badge back for an unseen update.
    await browser.reloadExtension();
    let text = '';
    for (let i = 0; i < 50 && text !== 'NEW'; i += 1) {
      await wait(200);
      try {
        text = await badge();
      } catch {
        text = '';
      }
    }
    check(text === 'NEW', `badge text: ${JSON.stringify(text)}`);
    const tab = await openProblem();
    await tab.waitFor(`!window.__q('.update').hidden`, { what: 'the update row' });
    const ui = await tab.eval(`(() => {
      const row = window.__q('.update'), r = row.getBoundingClientRect(), head = window.__q('.head').getBoundingClientRect(), scroll = window.__q('.scroll').getBoundingClientRect();
      const link = window.__q('.update-link').getBoundingClientRect(), close = window.__q('.update-close').getBoundingClientRect();
      return { text: window.__q('.update-text').textContent, link: window.__q('.update-link').textContent, role: row.getAttribute('role'),
        below: Math.abs(r.top - head.bottom) < 1.5, above: Math.abs(scroll.top - r.bottom) < 1.5, h: r.height,
        order: link.right <= close.left + 4 && link.left > window.__q('.update-text').getBoundingClientRect().left,
        closeLabel: window.__q('.update-close').getAttribute('aria-label'), rowRight: r.right, closeRight: close.right, mid: Math.abs((link.top + link.height / 2) - (r.top + r.height / 2)) };
    })()`);
    check(ui.text === `Updated from 1.2.0 to ${manifest.version}.` && ui.link === "What's new" && ui.role === 'status', JSON.stringify(ui));
    check(ui.below && ui.above && ui.h >= 24 && ui.h <= 40 && ui.order && ui.mid < 1.5 && ui.closeRight <= ui.rowRight, `layout: ${JSON.stringify(ui)}`);
    check(ui.closeLabel === 'Dismiss', 'the close button is labelled');
    await tab.screenshot(path.join(shots, 'update-row.png'), { width: 1100, height: 760 });
    tab.close();
  });

  await scenario('Dismiss hides the row, clears the note and the badge', async () => {
    const tab = await openProblem();
    await tab.waitFor(`!window.__q('.update').hidden`, { what: 'the update row' });
    await tab.eval(`window.__q('.update-close').click()`);
    await tab.waitFor(`window.__q('.update').hidden`, { what: 'the row to go' });
    for (let i = 0; i < 20 && (await stored()); i += 1) await wait(100);
    check((await stored()) === null, 'the note is cleared');
    check((await badge()) === '', `the badge is cleared: ${JSON.stringify(await badge())}`);
    tab.close();
  });

  await scenario("What's new opens the Changelog, which shows what changed and counts as seeing it", async () => {
    await writeNote({ from: '1.2.0', to: manifest.version });
    await browser.serviceWorkerEval(`chrome.action.setBadgeText({ text: 'NEW' })`);
    const tab = await openProblem();
    await tab.waitFor(`!window.__q('.update').hidden`, { what: 'the update row' });
    await tab.eval(`window.__q('.update-link').click()`);
    const isChangelog = (url) => /settings\.html#changelog$/.test(url);
    let opened = false;
    for (let i = 0; i < 40 && !opened; i += 1) {
      opened = (await browser.listTargets()).some((t) => t.type === 'page' && isChangelog(t.url));
      if (!opened) await wait(100);
    }
    check(opened, 'a Changelog tab opened');
    const page = await browser.attachPage(isChangelog);
    await page.waitFor(`document.getElementById('changelog-updated')`, { what: 'the updated line' });
    check((await page.eval(`document.getElementById('changelog-updated').textContent`)) === `Updated from 1.2.0 to ${manifest.version}.`, 'says what updated');
    for (let i = 0; i < 20 && (await stored()); i += 1) await wait(100);
    check((await stored()) === null && (await badge()) === '', `seen: note ${JSON.stringify(await stored())}, badge ${JSON.stringify(await badge())}`);
    await page.screenshot(path.join(shots, 'changelog-updated.png'), { width: 1100, height: 900 });
    page.close();
    // Back on the problem page (the new tab took focus, so it only redraws
    // now): the row is gone for good.
    await tab.send('Page.bringToFront');
    await tab.waitFor(`window.__q('.update').hidden`, { what: 'the row to go' });
    await wait(500);
    check(await tab.eval(`window.__q('.update').hidden`), 'and it stays gone after the page asks again');
    tab.close();
  });
} finally {
  await browser.close();
  copy.cleanup && copy.cleanup();
}
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} scenarios passed`);
process.exit(failed ? 1 : 0);
