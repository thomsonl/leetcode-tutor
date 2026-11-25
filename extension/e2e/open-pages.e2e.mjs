// End-to-end check of the Tutor panel's header buttons in the REAL unpacked
// extension (Playwright's cached Chromium): a leetcode.com problem page is
// served by the browser itself (CDP Fetch fulfils it with panel-fixture.html).
//
// Proves: the "Your progress" button sits between "Practice a skill" and
// the gear; it opens a card over the page with the Progress view in it (and
// "Open full page" opens the extension page on its Progress tab); the gear opens
// (or moves the same page to) its Settings tab, and a page already open is
// reused, never duplicated.
//
// Run with:  node extension/e2e/open-pages.e2e.mjs

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { extensionCopy, launch } from './cdp.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const extensionDir = path.resolve(here, '..');
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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const copy = extensionCopy(extensionDir, {});
const browser = await launch({ extensionDir: copy.dir });
try {
  const tab = await browser.openPage('about:blank');
  await tab.send('Fetch.enable', { patterns: [{ urlPattern: 'https://leetcode.com/*' }] });
  tab.on('Fetch.requestPaused', async (p) => {
    const url = new URL(p.request.url);
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
  await tab.waitFor(`document.readyState === 'complete' && document.querySelector('[data-lc-tutor-tab]')`, { what: 'the problem page' });
  await tab.eval(`document.querySelector('[data-lc-tutor-tab]').dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0 }))`);
  const q = (sel) => `document.getElementById('lc-tutor-panel-host').shadowRoot.querySelector(${JSON.stringify(sel)})`;
  await tab.waitFor(`${q('.head-right')} !== null && !${q('button.progress-open')}.hidden`, { what: 'the header buttons' });
  const optionsTabs = () => browser.serviceWorkerEval(`chrome.runtime.getContexts({ contextTypes: ['TAB'] }).then((c) => c.map((x) => x.documentUrl).filter((u) => u && u.split('#')[0] === chrome.runtime.getURL('settings.html')))`);

  await scenario('the Progress button sits between Practice a skill and the gear, same size and look', async () => {
    const m = await tab.eval(`(() => {
      const kids = [...${q('.head-right')}.children];
      const names = kids.filter((k) => !k.hidden).map((k) => k.className.split(' ')[0]);
      const b = ${q('button.progress-open')}; const pr = ${q('button.practice-open')}; const g = ${q('button.gear')};
      const rb = b.getBoundingClientRect(); const rg = g.getBoundingClientRect();
      return { names, size: [rb.width, rb.height], label: b.getAttribute('aria-label'), title: b.title, color: getComputedStyle(b).color === getComputedStyle(g).color, gap: Math.round(rg.left - rb.right), practiceFirst: pr.getBoundingClientRect().right <= rb.left };
    })()`);
    check(m.names.filter((n) => n !== 'model').join() === 'practice-open,progress-open,gear', JSON.stringify(m));
    check(m.size.join() === '24,24' && m.label === 'Your progress' && m.title === 'Your progress' && m.color && m.practiceFirst, JSON.stringify(m));
  });

  // Evaluates in the card's own frame (an extension page inside the problem page,
  // so its own target), by talking to it directly.
  const frameEval = async (expression) => {
    const target = (await browser.listTargets()).find((t) => t.url.includes('progress-card.html'));
    if (!target) return undefined;
    const ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      ws.addEventListener('open', resolve, { once: true });
      ws.addEventListener('error', reject, { once: true });
    });
    const value = await new Promise((resolve) => {
      ws.addEventListener('message', (m) => {
        const d = JSON.parse(m.data);
        if (d.id === 1) resolve(d.result && d.result.result ? d.result.result.value : undefined);
      });
      ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression, returnByValue: true, awaitPromise: true } }));
    });
    ws.close();
    return value;
  };
  // The popup is its own element on the page (not inside the panel, which would clip it).
  const m = (sel) => `document.getElementById('lc-tutor-progress-modal').shadowRoot.querySelector(${JSON.stringify(sel)})`;
  const card = () => tab.eval(`(() => {
    const host = document.getElementById('lc-tutor-progress-modal');
    const b = ${q('button.progress-open')};
    if (!host) return { hidden: true, expanded: b.getAttribute('aria-expanded'), src: '', box: [0, 0], dim: 0 };
    const c = ${m('.dialog')}; const bd = ${m('.backdrop')};
    const alpha = Number((getComputedStyle(bd).backgroundColor.match(/[\\d.]+/g) || [])[3] ?? 1);
    return { hidden: bd.hidden, expanded: b.getAttribute('aria-expanded'), src: ${m('iframe')}.src, box: [Math.round(c.getBoundingClientRect().width), Math.round(c.getBoundingClientRect().height)], dim: alpha, vw: innerWidth, vh: innerHeight };
  })()`);

  await scenario('the Progress button opens a popup over most of the screen with the Progress view in it, and no new tab', async () => {
    await browser.serviceWorkerEval(`chrome.storage.local.set({ solvedProblems: { 'two-sum': { at: '2026-11-02T18:30:00.000Z', count: 1 }, 'valid-anagram': { at: '2026-11-02T18:30:00.000Z', count: 1 }, '3sum': { at: '2026-11-02T18:30:00.000Z', count: 1 } } })`);
    check((await optionsTabs()).length === 0, 'no options page yet');
    check((await card()).hidden, 'the card starts closed');
    await tab.eval(`${q('button.progress-open')}.click()`);
    const open = await card();
    check(!open.hidden && open.expanded === 'true' && /^chrome-extension:\/\/[a-p]{32}\/progress-card\.html\?embed&theme=(dark|light)$/.test(open.src), JSON.stringify(open));
    check(open.box[0] >= 0.85 * open.vw && open.box[1] >= 0.85 * open.vh, `most of the screen: ${open.box} of ${open.vw}x${open.vh}`);
    check(open.dim > 0 && open.dim <= 0.45, `the page behind is only lightly dimmed: ${open.dim}`);
    // The same summary and roadmap graph the page shows, drawn in the frame.
    let ready = false;
    for (let i = 0; i < 50 && !ready; i += 1) {
      ready = await frameEval(`Boolean(document.querySelector('#summary .total') && document.querySelector('#canvas svg'))`);
      if (!ready) await sleep(150);
    }
    check(ready, 'the summary and the graph are drawn in the card');
    check(await frameEval(`document.body.classList.contains('embed') && !document.querySelector('.page-head')`), 'the card has no page header');
    check(await frameEval(`!document.getElementById('sync-btn') && !document.getElementById('sync-status')`), 'the card has no sync button');
    // The same bars as the Progress tab: difficulty colors in the big bar and in every topic node, no row of difficulty counts.
    check(await frameEval(`document.querySelectorAll('#summary .bar .bar-seg').length >= 1 && document.querySelectorAll('.levels').length === 0`), 'the summary is one multi-colored bar');
    check(await frameEval(`[...document.querySelectorAll('.node-bar')].every((b) => b.dataset.style === 'difficulty') && document.querySelectorAll('.node-bar .node-seg').length > 0`), 'the topic nodes are filled by difficulty too');
    check(await frameEval(`(() => { const c = document.getElementById('canvas'); return c.scrollWidth <= c.clientWidth + 1; })()`), 'the whole graph fits the card, with no sideways scrolling');
    check(await frameEval(`document.scrollingElement.scrollTop === 0`), 'the card starts at the top');
    check(await frameEval(`[...document.querySelectorAll('.node-title')].every((t) => t.scrollWidth <= t.clientWidth + 1)`), 'no topic name is cut off');
    await sleep(300);
    check((await optionsTabs()).length === 0, 'it opened no tab');
    await tab.eval(`${q('button.progress-open')}.click()`);
    check((await card()).hidden, 'the button closes it again');
  });

  await scenario('Escape, the close button and a click on the dimmed page close the popup; the frame is kept', async () => {
    const frameSrc = (await card()).src;
    await tab.eval(`${q('button.progress-open')}.click()`);
    check(!(await card()).hidden, 'open');
    await tab.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    await tab.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    check((await card()).hidden, 'Escape closes it');
    await tab.eval(`${q('button.progress-open')}.click()`);
    await tab.eval(`${m('.close')}.click()`);
    check((await card()).hidden, 'the close button closes it');
    await tab.eval(`${q('button.progress-open')}.click()`);
    await tab.eval(`${m('.dialog')}.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, composed: true }))`);
    check(!(await card()).hidden, 'a click inside it does not');
    await tab.eval(`${m('.backdrop')}.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, composed: true }))`);
    check((await card()).hidden, 'a click on the dimmed page outside it closes it');
    check((await card()).src === frameSrc, 'the loaded frame is kept for the next time');
  });

  await scenario('"Open full page" opens the Progress tab and closes the card', async () => {
    await tab.eval(`${q('button.progress-open')}.click()`);
    await tab.eval(`${m('.link')}.click()`);
    for (let i = 0; i < 30 && (await optionsTabs()).length === 0; i += 1) await sleep(100);
    const urls = await optionsTabs();
    check(urls.length === 1 && urls[0].endsWith('settings.html#progress'), JSON.stringify(urls));
    check((await card()).hidden, 'the card closed');
  });

  await scenario('the gear moves that same page to Settings, and the card\'s link back, with no second tab', async () => {
    await tab.eval(`${q('button.gear')}.click()`);
    for (let i = 0; i < 30 && !(await optionsTabs())[0].endsWith('#settings'); i += 1) await sleep(100);
    let urls = await optionsTabs();
    check(urls.length === 1 && urls[0].endsWith('settings.html#settings'), JSON.stringify(urls));
    await tab.eval(`${q('button.progress-open')}.click()`);
    await tab.eval(`${m('.link')}.click()`);
    for (let i = 0; i < 30 && !(await optionsTabs())[0].endsWith('#progress'); i += 1) await sleep(100);
    urls = await optionsTabs();
    check(urls.length === 1 && urls[0].endsWith('#progress'), JSON.stringify(urls));
  });

  await scenario('the page shows the tab it was sent to', async () => {
    const page = await browser.attachPage((u) => /settings\.html/.test(u));
    await tab.eval(`${q('button.gear')}.click()`);
    await page.waitFor(`document.getElementById('tab-settings').getAttribute('aria-selected') === 'true' && !document.getElementById('panel-settings').hidden`, { what: 'the Settings tab' });
    await tab.eval(`${q('button.progress-open')}.click()`);
    await tab.eval(`${m('.link')}.click()`);
    await page.waitFor(`document.getElementById('tab-progress').getAttribute('aria-selected') === 'true' && !document.getElementById('panel-progress').hidden`, { what: 'the Progress tab' });
  });
} finally {
  await browser.close();
  copy.cleanup && copy.cleanup();
}
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} scenarios passed`);
process.exit(failed ? 1 : 0);
