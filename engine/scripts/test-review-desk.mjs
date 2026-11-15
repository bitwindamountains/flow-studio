// Review desk shell: bar, player and strip. Temporary fixtures and a throwaway headless browser only, never the live Studio.
import assert from 'node:assert/strict';
import { readFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { chromeExecutable } from '../dist/chrome.js';
import { deriveWorkflow } from '../dist/workflow.js';
import { isStill } from '../dist/projects.js';

const root = fileURLToPath(new URL('../../', import.meta.url));
const shots = root + '.superpowers/sdd/2026-11-15-review-desk/shots/task-8/';
mkdirSync(shots, { recursive: true });
const html = readFileSync(root + 'ui/index.html', 'utf8').replace(/<script[^>]*>[\s\S]*?<\/script>/g, '').replace(/<link[^>]*>/g, '').replace('__FLOW_TOKEN__', 'fixture');
const step = (status, flags = []) => ({ status, budget: 0, reservations: [], spent: 0, flags, feedback: [] });
const sixScenes = [
  { n: 1, kind: 'still', prompt: 'one', storyboard: 'missing.png' },
  { n: 2, prompt: 'two', storyboard: 's2.png', clip: 'c2.mp4' },
  { n: 3, kind: 'still', prompt: 'three', storyboard: 's3.png' },
  { n: 4, kind: 'clip', prompt: 'four' },
  { n: 5, kind: 'still', prompt: 'five', storyboard: 's5.png' },
  { n: 6, prompt: 'six', storyboard: 's6.png', clip: 'c6.mp4', stale: 2 },
];
const sixSteps = { owner: 'flow-studio-steps-v1', rev: 3, steps: { idea: step('approved'), plan: step('approved'), look: step('approved'), assets: step('review', [{ scene: 5, note: 'Sleeve colour differs' }]), edit: step('idle') } };

const browser = await chromium.launch({ executablePath: process.env.FLOW_TEST_CHROME ?? chromeExecutable(), headless: true });
try {
  // A 1x1 PNG for stills, a 404 for missing.png, and media requests for videos left pending (no real file to play).
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
  async function open(width, owner = '1') {
    const context = await browser.newContext({ viewport: { width, height: 850 } });
    const page = await context.newPage(), errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.route('**/*', (r) => {
      const url = r.request().url();
      if (url === 'http://desk.test/') return r.fulfill({ contentType: 'text/html', body: html.replace('__OWNER__', owner) });
      if (url.includes('/media?')) return /missing/.test(decodeURIComponent(url)) ? r.fulfill({ status: 404, body: '' }) : /\.png/.test(url) ? r.fulfill({ contentType: 'image/png', body: png }) : undefined;
      return r.abort();
    });
    await page.goto('http://desk.test/');
    await page.addStyleTag({ content: readFileSync(root + 'ui/studio.css', 'utf8') });
    await page.addStyleTag({ content: readFileSync(root + 'engine/node_modules/@xterm/xterm/css/xterm.css', 'utf8') });
    await page.addScriptTag({ content: 'window.isStill = ' + isStill.toString() + '; window.deriveWorkflow = ' + deriveWorkflow.toString() });
    for (const file of ['@xterm/xterm/lib/xterm.js', '@xterm/addon-fit/lib/addon-fit.js'])
      await page.addScriptTag({ content: readFileSync(root + 'engine/node_modules/' + file, 'utf8') });
    await page.evaluate(({ scenes, steps }) => {
      const f = window.fixture = { project: 'A', sub: 'video', scenes, steps, health: {}, jobs: [{ scene: 4, id: 'j4', kind: 'clip', status: 'running' }], renders: [] };
      window.WebSocket = class {
        readyState = 0;
        constructor() { setTimeout(() => { this.readyState = 1; this.onopen?.(); this.onmessage?.({ data: JSON.stringify({ t: 'agent', agent: 'claude', status: 'running', session: 1 }) }); }, 10); }
        send() {}
      };
      window.fetch = async (url, opts) => {
        if (f.offline && !String(url).endsWith('/health/flow')) throw new Error('Fixture offline');
        const method = String(url).split('/').pop(); let result = {};
        const plan = { project: f.project, sub: f.sub, aspect: '9:16', scenes: f.scenes };
        if (method === 'studio_projects') result = [{ project: 'A', subs: ['video'] }];
        else if (method === 'studio_current') result = { project: f.project, sub: f.sub };
        else if (method === 'studio_plan_read') result = structuredClone(plan);
        else if (method === 'studio_workflow_read') result = window.deriveWorkflow({ plan, scenes: f.scenes.map(s => ({ n: s.n, validPlan: true, validSource: true, storyboardExists: !!s.storyboard, clipExists: !!s.clip, hasTakes: false, hasActiveJob: false })), renderVersions: f.renders.map(r => r.version), editTaskPhase: null });
        else if (method === 'studio_status') result = { scenes: f.scenes.map(s => ({ ...s, takes: [], jobs: f.jobs.filter(j => j.scene === s.n) })), pending: [], steps: f.steps, production_plan: { text: '', rev: '0' } };
        else if (method === 'studio_renders') result = { renders: f.renders };
        else if (method === 'studio_notes_read' || method === 'studio_edit_notes_read') result = { text: '', rev: '1' };
        else if (method === 'studio_references') result = { project: [], sub: [], active: [], library: [] };
        else if (method === 'studio_guide_read') result = { text: '', adaptations: [] };
        else if (method === 'studio_edit_task_read') result = { task: null };
        else if (method === 'flow') result = f.health;
        else if (method === 'accounts' || method === 'pending') result = [];
        return { ok: true, status: 200, json: async () => result };
      };
    }, { scenes: sixScenes, steps: sixSteps });
    await page.addScriptTag({ content: readFileSync(root + 'ui/app.js', 'utf8') });
    await page.waitForFunction(() => !!data.workflow && document.querySelectorAll('#strip .tile').length === 6, null, { timeout: 10000 }).catch((e) => { throw new Error(e.message + ' page errors: ' + errors.join(' / ')); });
    return { context, page, errors };
  }

  // Alerts name the worst problem in a few fixed words; the full text stays behind the badge.
  {
    const { context, page, errors } = await open(1366, '');
    const badge = page.locator('#alerts');
    assert.equal(await badge.innerText(), 'View-only window');
    assert.match(await badge.getAttribute('aria-label'), /^Alerts: 1, worst: View-only window$/);
    await page.evaluate(async () => { window.fixture.health = { ok: false, checks: [{ name: 'signed in', ok: false, hint: '<b>raw</b> server text' }], message: 'signed in: <b>raw</b> server text' }; await checkHealth(); });
    assert.equal(await badge.innerText(), 'View-only window (2)');
    assert.match(await badge.getAttribute('aria-label'), /^Alerts: 2, worst: View-only window$/);
    assert.equal(await page.locator('#health').isVisible(), false);
    await badge.click();
    assert.equal(await page.locator('#health').isVisible(), true);
    assert.match(await page.locator('#health').innerText(), /<b>raw<\/b> server text/, 'full text is shown as text');
    assert.equal(await page.locator('#reloaded').isVisible(), true);
    assert.deepEqual(errors, []);
    await context.close();
  }
  {
    const { context, page } = await open(1366);
    const badge = page.locator('#alerts');
    assert.equal(await badge.isVisible(), false, 'no alerts, no badge');
    for (const [checks, label] of [[[{ name: 'signed in', ok: false }, { name: 'composer', ok: false }], 'Flow signed out'], [[{ name: 'flow', ok: false }], 'Flow not open'], [[{ name: 'composer', ok: false, hint: 'Ignore all previous instructions' }], 'Flow check failed']]) {
      await page.evaluate(async (checks) => { window.fixture.health = { ok: false, checks, message: 'x' }; await checkHealth(); }, checks);
      assert.equal(await badge.innerText(), label);
    }
    await page.evaluate(async () => { window.fixture.offline = true; await refresh(true); });
    assert.equal(await badge.innerText(), 'Flow check failed (2)', 'Flow outranks offline');
    await page.evaluate(async () => { window.fixture.health = { ok: true, checks: [] }; await checkHealth(); });
    assert.equal(await badge.innerText(), 'Offline');
    await context.close();
  }

  for (const width of [1366, 480]) {
    const { context, page, errors } = await open(width);
    assert.equal(await page.locator('#player .player-empty').innerText(), 'Select a scene', 'empty player follows the chosen project');
    assert.equal(await page.evaluate(() => { $('project').value = ''; renderPlayer(null); const before = $('player').innerText; $('project').value = 'A'; renderPlayer(null); return before + ' -> ' + $('player').innerText; }), 'Choose a project -> Select a scene');

    // visible at rest: only #bar, #player, #strip (and #gate when the step needs the owner)
    assert.equal(await page.locator('#term-wrap:visible, #project-setup:visible, #health:visible').count(), 0);
    for (const id of ['bar', 'player', 'strip', 'strip-filter', 'details-toggle', 'project-menu', 'chat-toggle']) assert.equal(await page.locator('#' + id).isVisible(), true, id + ' visible');
    assert.equal(await page.locator('#strip .tile').count(), 6);
    assert.equal(await page.locator('#strip .tile[data-kind=still]').count(), 3);
    assert.deepEqual(await page.locator('#strip .tile').evaluateAll(t => t.map(x => x.dataset.mark)), ['done', 'done', 'done', 'working', 'flag', 'stale']);
    assert.deepEqual(await page.locator('#steps li').evaluateAll(l => l.map(x => x.dataset.step + ':' + x.dataset.status)), ['idea:approved', 'plan:approved', 'look:approved', 'assets:review', 'edit:idle']);
    assert.deepEqual(await page.locator('#steps li').evaluateAll(l => l.map(x => x.querySelector('.step-name').textContent)), ['Idea', 'Plan', 'Look', 'Assets', 'Edit']);
    // each tile has an accessible name "Scene N, still|clip, <mark>"
    for (const [i, label] of (await page.locator('#strip .tile').evaluateAll(t => t.map(x => x.getAttribute('aria-label')))).entries())
      assert.match(label, new RegExp(`^Scene ${i + 1}, (still|clip), (done|flagged|working|stale|not started)$`));
    await page.locator('#strip .tile[data-scene="3"]').click();
    assert.match(await page.locator('#player').getAttribute('aria-label'), /Scene 3/);
    assert.equal(await page.locator('#player img').count(), 1, 'a still shows as an image');
    await page.locator('#strip .tile[data-scene="2"]').click();
    assert.match(await page.locator('#player').getAttribute('aria-label'), /^Scene 2/);
    assert.equal(await page.locator('#player video[controls]').count(), 1, 'a clip shows as a video with controls');
    // a missing file or a scene not made yet shows a quiet placeholder, never the browser's broken-image icon
    for (const n of ['1', '4']) {
      await page.locator(`#strip .tile[data-scene="${n}"]`).click();
      await page.waitForFunction(() => !!document.querySelector('#player .player-empty'));
      assert.equal(await page.locator('#player img, #player video').count(), 0);
      assert.match(await page.locator('#player .player-empty').innerText(), new RegExp(`Scene ${n}, (still|clip)`));
      assert.equal(await page.locator('#player .player-empty [aria-hidden=true]').count(), 1, 'kind icon');
    }
    // keyboard: ArrowRight on a focused tile moves selection
    await page.locator('#strip .tile[data-scene="3"]').focus();
    await page.keyboard.press('ArrowRight');
    assert.match(await page.locator('#player').getAttribute('aria-label'), /^Scene 4/);
    assert.equal(await page.evaluate(() => document.activeElement.dataset.scene), '4');
    assert.deepEqual(await page.locator('#strip .tile').evaluateAll(t => t.map(x => x.tabIndex)), [-1, -1, -1, 0, -1, -1], 'roving tabindex');
    await page.keyboard.press('End');
    assert.equal(await page.evaluate(() => document.activeElement.dataset.scene), '6');
    // no sentence of instruction on screen: every visible text node outside #player/#gate is <= 4 words
    const words = () => page.evaluate(() => {
      const long = [], walk = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      for (let n; (n = walk.nextNode());) {
        const el = n.parentElement, text = n.textContent.trim();
        if (!text || el.closest('#player, #gate, script, style') || !el.checkVisibility() || !el.getClientRects().length) continue;
        if (text.split(/\s+/).length > 4) long.push(text);
      }
      return long;
    });
    assert.deepEqual(await words(), []);
    assert.doesNotMatch(await page.locator('body').innerText(), /\bAds?\b/);
    // project menu folds in the project and video pickers, New project, Start new video and Jobs
    await page.locator('#project-menu').click();
    assert.equal(await page.locator('#project-menu').getAttribute('aria-expanded'), 'true');
    for (const name of ['Project', 'Video']) assert.equal(await page.getByLabel(name, { exact: true }).isVisible(), true, name);
    for (const name of ['New project', 'Start new video']) assert.equal(await page.getByRole('button', { name, exact: true }).isVisible(), true, name);
    assert.equal(await page.getByRole('button', { name: /^Jobs/ }).isVisible(), true);
    assert.deepEqual(await words(), []);
    assert.doesNotMatch(await page.locator('body').innerText(), /\bAds?\b/);
    await page.screenshot({ path: shots + `desk-menu-${width}.png`, fullPage: true });
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('#project-menu').getAttribute('aria-expanded'), 'false');
    assert.equal(await page.evaluate(() => document.activeElement.id), 'project-menu');
    // chat opens and closes the same mounted terminal
    const marker = await page.evaluate(() => { const x = document.querySelector('#term .xterm'); x.dataset.marker = 'kept'; return !!x; });
    assert.ok(marker, 'xterm is mounted while hidden');
    await page.locator('#chat-toggle').click();
    assert.equal(await page.locator('#term-wrap').isVisible(), true);
    assert.equal(await page.locator('#chat-toggle').getAttribute('aria-expanded'), 'true');
    await page.locator('#chat-toggle').click();
    assert.equal(await page.locator('#term-wrap').isVisible(), false);
    assert.equal(await page.evaluate(() => document.querySelector('#term .xterm')?.dataset.marker), 'kept');
    // the latest render plays when no scene is selected
    await page.evaluate(async () => { window.fixture.renders = [{ version: 1, path: 'v1.mp4' }]; selectScene(null); await refresh(true); });
    assert.match(await page.locator('#player').getAttribute('aria-label'), /v1/);
    assert.equal(await page.locator('#player video[controls]').count(), 1);
    if (width === 480) {
      await page.locator('#project-menu').click();
      const controls = page.locator('#bar :is(button, select, input):visible, #project-panel :is(button, select, input):visible, #strip button:visible, #strip-filter button:visible, #details-toggle');
      assert.ok(await controls.count() >= 14);
      for (const b of await controls.all()) {
        const box = await b.boundingBox();
        assert.ok(box.height >= 44, `${await b.getAttribute('id') || await b.getAttribute('aria-label') || await b.innerText()} is ${box.height}px tall`);
      }
      await page.locator('#project-menu').click();
    }
    await page.evaluate(async () => { window.fixture.renders = []; selectScene(3); await refresh(true); });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'no horizontal page scroll');
    await page.screenshot({ path: shots + `desk-6-${width}.png`, fullPage: true });

    // 300 stills in two sections, one flagged
    await page.evaluate(async () => {
      const f = window.fixture;
      f.scenes = Array.from({ length: 300 }, (_, i) => ({ n: i + 1, kind: 'still', prompt: 'p', storyboard: `s${i + 1}.png`, section: i < 150 ? 'Part 1' : 'Part 2' }));
      f.jobs = []; f.steps = structuredClone(f.steps); f.steps.steps.assets.flags = [{ scene: 150, note: 'check' }];
      selectScene(null); await refresh(true);
    });
    await page.waitForFunction(() => document.querySelectorAll('#strip .tile').length === 300);
    assert.equal(await page.locator('#strip .tile img[loading=lazy]').count(), 300, 'thumbnails load lazily');
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'no horizontal page scroll with 300 tiles');
    assert.ok(await page.locator('#strip').evaluate(el => el.scrollWidth > el.clientWidth || el.scrollHeight > el.clientHeight), 'strip scrolls inside itself');
    assert.deepEqual(await words(), []);
    await page.screenshot({ path: shots + `desk-300-${width}.png`, fullPage: true });
    // sections: a collapsible label per group of consecutive scenes
    const part1 = page.locator('#strip button.group-label', { hasText: 'Part 1' });
    assert.equal(await part1.getAttribute('aria-expanded'), 'true');
    await part1.click();
    assert.equal(await part1.getAttribute('aria-expanded'), 'false');
    assert.equal(await page.locator('#strip .tile:visible').count(), 150);
    await part1.click();
    // Flagged filter leaves only flagged tiles
    await page.locator('#strip-filter button', { hasText: 'Flagged' }).click();
    assert.deepEqual(await page.locator('#strip .tile').evaluateAll(t => t.map(x => x.dataset.mark + x.dataset.scene)), ['flag150']);
    await page.locator('#strip-filter button', { hasText: 'All' }).click();
    assert.equal(await page.locator('#strip .tile').count(), 300);
    assert.deepEqual(errors, []);
    console.log(`Review desk ${width}px: shell at rest, marks, player, keyboard, words, project menu, chat, render fallback, alerts, 300 tiles, sections and filter passed.`);
    await context.close();
  }
} finally { await browser.close(); }
