// End-to-end check of the Tutor | Interviewer switch in the REAL unpacked
// extension (Playwright's cached Chromium), the extension's own runtime with a
// stub OpenAI-compatible model: the header shows the switch, choosing a mode
// starts a fresh conversation (a notice, an empty feed, a new backend that
// carries that mode's prompt and the full code again), the mode is the same
// across problems and tabs and survives a reload, and it can be switched back.
//
// The problem page is https://leetcode.com/problems/two-sum/ served by the
// browser itself (CDP Fetch fulfils it with panel-fixture.html plus a fake
// Monaco). The extension is a copy whose manifest pre-grants 127.0.0.1.
//
// Run with:  node extension/e2e/mode-switch.e2e.mjs
// Screenshots land in $LC_E2E_SHOTS (default /tmp/lc-mode-shots).

import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { extensionCopy, launch } from './cdp.mjs';
import { DEFAULT_PROMPTS, FIXED_RULES, systemMessageFor } from '../shared/tutor-prompt.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const extensionDir = path.resolve(here, '..');
const shots = process.env.LC_E2E_SHOTS || '/tmp/lc-mode-shots';
fs.mkdirSync(shots, { recursive: true });

const fixture = fs.readFileSync(path.join(here, 'panel-fixture.html'), 'utf8').replace(
  '</head>',
  `<script>
  window.__editorCode = 'class Solution:\\n    def twoSum(self, nums, target):\\n        return []\\n';
  window.monaco = { editor: { getEditors: () => [{
    getDomNode: () => document.getElementById('pane-code'),
    getModel: () => ({ getValue: () => window.__editorCode, getLanguageId: () => 'python' }),
  }] } };
</script>
</head>`
);

const model = { requests: [] };
const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    if (req.method !== 'POST' || !/\/chat\/completions$/.test(req.url)) return void res.writeHead(404).end();
    const parsed = JSON.parse(body);
    if (!parsed.stream) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return void res.end(JSON.stringify({ choices: [{ message: { content: 'OK' }, finish_reason: 'stop' }] }));
    }
    model.requests.push(parsed);
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const text = `Reply ${model.requests.length}: a short answer. `;
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`);
    res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\n`);
    res.end('data: [DONE]\n\n');
  });
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const modelUrl = `http://127.0.0.1:${server.address().port}/v1`;

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
const systemOf = (request) => request.messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const copy = extensionCopy(extensionDir, { extraHosts: ['http://127.0.0.1/*'] });
const browser = await launch({ extensionDir: copy.dir });
try {
  const options = await browser.openPage('about:blank');
  await options.failFetch('http://localhost:8135/*');
  await options.send('Page.navigate', { url: `chrome-extension://${browser.extensionId}/settings.html` });
  await options.waitFor(`document.getElementById('connection-text').textContent === 'Not set up'`, { what: 'the options page' });
  await options.type('#local-baseUrl', modelUrl);
  await // Models are chosen in the add row; the model is typed through "Other" (this stub lists nothing).
  await await options.eval(`(() => { const p = document.getElementById('add-provider'); p.value = 'local'; p.dispatchEvent(new Event('change', { bubbles: true })); const s = document.getElementById('add-model'); s.value = '__other__'; s.dispatchEvent(new Event('change', { bubbles: true })); })()`);
  await await options.type('#add-model', 'stub-model');
  await await options.click('#add-profile-button');
  await options.waitFor(`document.getElementById('save-result').textContent.startsWith('Saved')`, { what: 'the save' });
  options.close();

  const helpers = `(() => {
    window.__root = () => document.getElementById('lc-tutor-panel-host').shadowRoot;
    window.__q = (sel) => window.__root().querySelector(sel);
    window.__qa = (sel) => [...window.__root().querySelectorAll(sel)];
    window.__openTutor = () => document.querySelector('[data-lc-tutor-tab]').dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0 }));
    window.__replies = () => window.__qa('.feed .tutor').map((n) => n.textContent);
    window.__feed = () => window.__qa('.feed > *').map((n) => n.className.split(' ')[0] + ': ' + n.textContent);
    window.__mode = () => window.__qa('.mode-opt').map((b) => b.textContent + (b.getAttribute('aria-pressed') === 'true' ? '*' : '') + (b.disabled ? '(off)' : '')).join(' ');
    window.__send = (text) => {
      const t = window.__q('textarea');
      t.value = text;
      t.dispatchEvent(new Event('input', { bubbles: true }));
      t.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    };
  })()`;
  async function openProblem(slug) {
    const tab = await browser.openPage('about:blank');
    await tab.send('Fetch.enable', { patterns: [{ urlPattern: 'https://leetcode.com/*' }, { urlPattern: 'http://localhost:8135/*' }] });
    tab.on('Fetch.requestPaused', async (p) => {
      const url = new URL(p.request.url);
      if (url.host === 'localhost:8135') {
        await tab.send('Fetch.failRequest', { requestId: p.requestId, errorReason: 'ConnectionRefused' });
        return;
      }
      const isPage = url.pathname.startsWith('/problems/');
      await tab.send('Fetch.fulfillRequest', {
        requestId: p.requestId,
        responseCode: isPage ? 200 : 404,
        responseHeaders: [{ name: 'Content-Type', value: 'text/html; charset=utf-8' }],
        body: Buffer.from(isPage ? fixture : '').toString('base64'),
      });
    });
    await tab.send('Emulation.setDeviceMetricsOverride', { width: 1100, height: 760, deviceScaleFactor: 1, mobile: false });
    await tab.send('Page.navigate', { url: `https://leetcode.com/problems/${slug}/description/` });
    await tab.waitFor(`document.readyState === 'complete'`, { what: `the ${slug} page` });
    await tab.eval(helpers);
    await tab.send('Page.bringToFront');
    await tab.waitFor(`document.querySelector('[data-lc-tutor-tab]')`, { what: 'the Tutor tab' });
    await tab.eval('window.__openTutor()');
    await tab.waitFor(`window.__q('.status span') && window.__q('.status span').textContent === 'Connected'`, { what: 'the Connected status' });
    return tab;
  }
  const page = await openProblem('two-sum');

  await scenario('the header shows Tutor | Interviewer with the tutor chosen, beside the model', async () => {
    await page.waitFor(`window.__q('.mode') && !window.__q('.mode').hidden`, { what: 'the mode switch' });
    check((await page.eval('window.__mode()')) === 'Tutor* Interviewer', await page.eval('window.__mode()'));
    const layout = await page.eval(`(() => {
      const r = (s) => window.__q(s).getBoundingClientRect();
      const m = r('.mode'), model = r('button.model'), head = r('.head');
      const opt = r('.mode-opt');
      return { modeRight: m.right, modelLeft: model.left, modeH: m.height, headH: head.height, modeTop: m.top - head.top, optH: opt.height, headRight: head.right, modeRightEdge: m.right, clipped: window.__q('.head-right').scrollWidth > window.__q('.head-right').clientWidth + 1 };
    })()`);
    check(layout.modeRight <= layout.modelLeft + 1, `the switch sits left of the model button: ${JSON.stringify(layout)}`);
    check(Math.abs(layout.modeTop + layout.modeH / 2 - layout.headH / 2) < 2, `centred in the header: ${JSON.stringify(layout)}`);
    check(layout.modeRight < layout.headRight, `inside the header: ${JSON.stringify(layout)}`);
    await page.screenshot(path.join(shots, 'header-tutor.png'), { width: 1100, height: 760 });
  });

  await scenario('a chat under the tutor prompt', async () => {
    await page.eval(`window.__send('what does this problem ask?')`);
    await page.waitFor(`window.__replies().some((t) => t.includes('Reply 1'))`, { what: 'the first reply', timeout: 10000 });
    check(systemOf(model.requests[0]).includes(systemMessageFor('tutor')), 'the tutor prompt is the system message');
    check(!systemOf(model.requests[0]).includes('technical interviewer'), 'and the interviewer prompt is not');
  });

  await scenario('choosing Interviewer clears the chat at once, and the notice shows with the next message', async () => {
    await page.eval(`window.__qa('.mode-opt')[1].click()`);
    await page.waitFor(`window.__mode() === 'Tutor Interviewer*'`, { what: 'Interviewer chosen' });
    // The highlight slides slowly: partway after a moment, under the chosen option once it is done.
    const thumb = () => page.eval(`(() => { const t = window.__q('.mode-thumb'); const b = window.__qa('.mode-opt')[1]; return { left: parseFloat(getComputedStyle(t).left), target: b.offsetLeft, ready: t.hasAttribute('data-ready') }; })()`);
    check((await thumb()).ready, 'the highlight is set up to animate');
    await page.waitFor(`(() => { const t = window.__q('.mode-thumb'); return Math.abs(parseFloat(getComputedStyle(t).left) - window.__qa('.mode-opt')[1].offsetLeft) < 0.5; })()`, { what: 'the highlight under Interviewer', timeout: 3000 });
    await page.waitFor(`window.__feed().length === 1 && window.__feed()[0].startsWith('empty:')`, { what: 'the empty feed' });
    const feed = await page.eval('window.__feed()');
    check(!feed.some((t) => t.includes('what does this problem ask?')) && !feed.some((t) => t.includes('Reply 1')), `the old chat is gone: ${JSON.stringify(feed)}`);
    // Like a new problem's notice, it is shown once something follows it.
    await page.eval(`window.__send('ready when you are')`);
    await page.waitFor(`window.__replies().some((t) => t.includes('Reply 2'))`, { what: 'the first interviewer reply', timeout: 10000 });
    const after = await page.eval('window.__feed()');
    check(/^notice: Switched to Interviewer mode\. Started a fresh conversation\.$/.test(after[0]), `the notice leads the new chat: ${JSON.stringify(after)}`);
    await page.screenshot(path.join(shots, 'header-interviewer.png'), { width: 1100, height: 760 });
  });

  await scenario('that first message went under the interviewer prompt with the full code again', async () => {
    const sent = model.requests[1];
    check(systemOf(sent).includes(systemMessageFor('interviewer')), 'the interviewer prompt is the system message');
    check(!systemOf(sent).includes(systemMessageFor('tutor')), 'the tutor prompt is gone');
    check(/Given an array of integers/.test(systemOf(sent)), 'the problem statement is pinned again');
    const last = sent.messages.at(-1).content;
    check(last.includes('ready when you are') && last.includes('return []'), `the code went in full: ${last}`);
    check(!sent.messages.some((m) => m.content.includes('what does this problem ask?')), 'nothing of the old chat went along');
  });

  await scenario('the mode is one setting: a reload and another problem keep it', async () => {
    await page.send('Page.reload');
    await page.waitFor(`document.readyState === 'complete' && document.querySelector('[data-lc-tutor-tab]')`, { what: 'the reloaded page' });
    await page.eval(helpers);
    await page.eval('window.__openTutor()');
    await page.waitFor(`window.__mode() === 'Tutor Interviewer*'`, { what: 'the mode after a reload' });
    const other = await openProblem('add-two-numbers');
    await other.waitFor(`window.__mode() === 'Tutor Interviewer*'`, { what: 'the mode on another problem' });
    // The other tab is in front now; switching back there reaches this tab too.
    await other.eval(`window.__qa('.mode-opt')[0].click()`);
    await other.waitFor(`window.__mode() === 'Tutor* Interviewer'`, { what: 'Tutor chosen again' });
    await page.send('Page.bringToFront');
    await page.waitFor(`window.__mode() === 'Tutor* Interviewer'`, { what: 'the first tab follows' });
    other.close();
  });

  await scenario('pressing the chosen mode again does nothing', async () => {
    const before = model.requests.length;
    await page.eval(`window.__qa('.mode-opt')[0].click()`);
    await wait(500);
    check(model.requests.length === before, 'no request');
    const feed = await page.eval('window.__feed()');
    check(feed.filter((t) => /Started a fresh conversation/.test(t)).length <= 1, `no second notice: ${JSON.stringify(feed)}`);
  });

  // ---- the Prompts card on the Settings page ---------------------------------
  const settings = await browser.openPage('about:blank');
  await settings.failFetch('http://localhost:8135/*');
  await settings.send('Emulation.setDeviceMetricsOverride', { width: 1100, height: 900, deviceScaleFactor: 1, mobile: false });
  await settings.send('Page.navigate', { url: `chrome-extension://${browser.extensionId}/settings.html` });
  await settings.waitFor(`document.getElementById('prompts-card') && !document.getElementById('prompts-card').hidden`, { what: 'the Prompts card' });
  const promptUi = () => settings.eval(`(() => ({
    text: document.getElementById('prompt-text').value,
    state: document.getElementById('prompt-state').textContent,
    count: document.getElementById('prompt-count').textContent,
    over: document.getElementById('prompt-count').classList.contains('over'),
    save: !document.getElementById('prompt-save').disabled,
    reset: !document.getElementById('prompt-reset').disabled,
    result: document.getElementById('prompt-result').textContent,
    resultKind: document.getElementById('prompt-result').getAttribute('data-kind') || '',
    tabs: [...document.querySelectorAll('.prompt-tab')].map((t) => t.firstChild.textContent + (t.getAttribute('aria-pressed') === 'true' ? '*' : '')).join(' | '),
  }))()`);
  const setPrompt = (text) => settings.eval(`(() => { const a = document.getElementById('prompt-text'); a.value = ${JSON.stringify(text)}; a.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  const stored = () => browser.serviceWorkerEval(`chrome.storage.local.get('tutorSettings').then((s) => ({ mode: s.tutorSettings.mode, prompts: s.tutorSettings.prompts }))`);
  const CUSTOM = 'You are a terse tutor. Ask one question per reply and never write code.';

  await scenario('the Prompts card shows the default tutor prompt, with nothing to save or reset', async () => {
    const ui = await promptUi();
    check(ui.text === DEFAULT_PROMPTS.tutor, 'the editor holds the default tutor prompt');
    check(ui.state === 'Default prompt' && !ui.save && !ui.reset, JSON.stringify(ui));
    check(ui.tabs === 'Tutor* | Interviewer', ui.tabs);
    check(await settings.eval(`!document.querySelector('.prompt-fixed')`), 'no fixed-rules section is shown');
    await settings.eval(`document.getElementById('prompts-card').scrollIntoView({ block: 'start' })`);
    await wait(200);
    await settings.screenshot(path.join(shots, 'settings-prompts.png'), { width: 1100, height: 900 });
  });

  await scenario('editing enables Save; saving stores it and starts a fresh conversation under the new prompt', async () => {
    await setPrompt(CUSTOM);
    let ui = await promptUi();
    check(ui.state === 'Unsaved changes' && ui.save && ui.reset, JSON.stringify(ui));
    check(ui.count === `${CUSTOM.length} / 12,000`, `the count: ${ui.count}`);
    await settings.eval(`document.getElementById('prompt-save').click()`);
    await settings.waitFor(`document.getElementById('prompt-result').textContent.startsWith('Saved.')`, { what: 'the save' });
    ui = await promptUi();
    check(ui.state === 'Edited prompt' && !ui.save && ui.reset && ui.resultKind === 'ok', JSON.stringify(ui));
    check((await stored()).prompts.tutor === CUSTOM, 'stored by the worker');
    // The Tutor tab: the chat is gone, and the next message goes under the new prompt.
    await page.send('Page.bringToFront');
    await page.waitFor(`window.__feed().length === 1 && window.__feed()[0].startsWith('empty:')`, { what: 'the cleared chat' });
    await page.eval(`window.__send('how do I begin?')`);
    await page.waitFor(`window.__replies().some((t) => t.includes('Reply ${model.requests.length + 1}'))`, { what: 'the reply', timeout: 10000 });
    const sent = model.requests.at(-1);
    check(systemOf(sent).startsWith(CUSTOM), `the system message starts with the student's prompt: ${systemOf(sent).slice(0, 80)}`);
    check(systemOf(sent).includes(FIXED_RULES), 'the fixed rules still follow it');
    check(!systemOf(sent).includes('Socratic') && !systemOf(sent).includes(DEFAULT_PROMPTS.tutor), 'the default prompt is gone');
    const feed = await page.eval('window.__feed()');
    check(/^notice: Prompt changed\. Started a fresh conversation\.$/.test(feed[0]), JSON.stringify(feed));
  });

  await scenario('Reset to default restores the original and starts another fresh conversation', async () => {
    await settings.send('Page.bringToFront');
    await settings.eval(`document.getElementById('prompt-reset').click()`);
    await settings.waitFor(`document.getElementById('prompt-result').textContent.startsWith('Reset.')`, { what: 'the reset' });
    const ui = await promptUi();
    check(ui.text === DEFAULT_PROMPTS.tutor && ui.state === 'Default prompt' && !ui.save && !ui.reset, JSON.stringify(ui));
    check((await stored()).prompts.tutor === null, 'stored as the default again');
    await page.send('Page.bringToFront');
    await page.eval(`window.__send('and now?')`);
    await page.waitFor(`window.__replies().some((t) => t.includes('Reply ${model.requests.length + 1}'))`, { what: 'the reply', timeout: 10000 });
    check(systemOf(model.requests.at(-1)).includes(systemMessageFor('tutor')), 'the default tutor prompt is back');
  });

  await scenario('the Interviewer prompt is edited on its own tab, and changing the mode in the Tutor tab leaves the editor alone', async () => {
    await settings.send('Page.bringToFront');
    await settings.eval(`document.querySelectorAll('.prompt-tab')[1].click()`);
    let ui = await promptUi();
    check(ui.text === DEFAULT_PROMPTS.interviewer && ui.tabs === 'Tutor | Interviewer*', JSON.stringify({ ...ui, text: ui.text.slice(0, 40) }));
    await page.send('Page.bringToFront');
    await page.eval(`window.__qa('.mode-opt')[1].click()`);
    await page.waitFor(`window.__mode() === 'Tutor Interviewer*'`, { what: 'Interviewer chosen' });
    await settings.send('Page.bringToFront');
    ui = await promptUi();
    check(ui.tabs === 'Tutor | Interviewer*', ui.tabs);
    // Unsaved typing survives, and switching tabs keeps each draft.
    await setPrompt('You are a strict interviewer. Say only: next question, please.');
    await settings.eval(`document.querySelectorAll('.prompt-tab')[0].click()`);
    check((await promptUi()).text === DEFAULT_PROMPTS.tutor, 'the tutor tab shows its own prompt');
    await settings.eval(`document.querySelectorAll('.prompt-tab')[1].click()`);
    check((await promptUi()).text === 'You are a strict interviewer. Say only: next question, please.', 'the interviewer draft is kept');
    await settings.eval(`document.getElementById('prompt-save').click()`);
    await settings.waitFor(`document.getElementById('prompt-result').textContent.startsWith('Saved.')`, { what: 'the save' });
    check((await stored()).prompts.interviewer === 'You are a strict interviewer. Say only: next question, please.', 'stored');
    check((await stored()).prompts.tutor === null, 'the tutor prompt is untouched');
    await page.send('Page.bringToFront');
    await page.eval(`window.__send('hello')`);
    await page.waitFor(`window.__replies().some((t) => t.includes('Reply ${model.requests.length + 1}'))`, { what: 'the reply', timeout: 10000 });
    check(systemOf(model.requests.at(-1)).startsWith('You are a strict interviewer.'), 'the interviewer now uses the student\'s prompt');
  });

  await scenario('a too-short prompt is refused with the reason, and a too-long one cannot be saved', async () => {
    await settings.send('Page.bringToFront');
    await setPrompt('tiny');
    await settings.eval(`document.getElementById('prompt-save').click()`);
    await settings.waitFor(`document.getElementById('prompt-result').getAttribute('data-kind') === 'error'`, { what: 'the refusal' });
    let ui = await promptUi();
    check(/at least 20 characters/.test(ui.result), ui.result);
    check((await stored()).prompts.interviewer === 'You are a strict interviewer. Say only: next question, please.', 'nothing changed');
    await setPrompt('x'.repeat(12001));
    ui = await promptUi();
    check(ui.over && !ui.save, JSON.stringify(ui));
    await settings.eval(`document.getElementById('prompts-card').scrollIntoView({ block: 'start' })`);
    await wait(200);
    await settings.screenshot(path.join(shots, 'settings-prompts-over.png'), { width: 1100, height: 900 });
  });
} finally {
  await browser.close();
  copy.cleanup && copy.cleanup();
  server.close();
}
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} scenarios passed`);
process.exit(failed ? 1 : 0);
