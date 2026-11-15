// Review desk shell: bar, gate, player and strip. Temporary fixtures and a throwaway headless browser only, never the live Studio.
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
const sixSteps = { owner: 'flow-studio-steps-v1', rev: 3, steps: { idea: step('approved'), plan: step('approved'), look: step('approved'), assets: { ...step('review', [{ scene: 5, note: 'Sleeve colour differs' }]), summary: 'All six scenes made.\nScene 5 sleeve differs.', budget: 400, spent: 50, reservations: [{ job: 'j4', credits: 11 }] }, edit: step('idle') } };
const shots9 = root + '.superpowers/sdd/2026-11-15-review-desk/shots/task-9/';
mkdirSync(shots9, { recursive: true });

const browser = await chromium.launch({ executablePath: process.env.FLOW_TEST_CHROME ?? chromeExecutable(), headless: true });
try {
  // A 1x1 PNG for stills, a 404 for missing.png, and media requests for videos left pending (no real file to play).
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
  async function open(width, owner = '1', before = null) {
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
      const f = window.fixture = { project: 'A', sub: 'video', scenes, steps, health: {}, jobs: [{ scene: 4, id: 'j4', kind: 'clip', status: 'running' }], renders: [], posts: [], replies: [] };
      window.WebSocket = class {
        readyState = 0;
        constructor() { setTimeout(() => { this.readyState = 1; this.onopen?.(); this.onmessage?.({ data: JSON.stringify({ t: 'agent', agent: 'claude', status: 'running', session: 1 }) }); }, 10); }
        send() {}
      };
      window.fetch = async (url, opts) => {
        if (f.offline && !String(url).endsWith('/health/flow')) throw new Error('Fixture offline');
        const method = String(url).split('/').pop(); let result = {};
        if (method === 'step') {
          f.posts.push(JSON.parse(opts.body));
          if (f.hold) await f.hold;
          const fail = f.replies.shift();
          return fail ? { ok: false, status: fail.status, json: async () => ({ error: fail.error }) } : { ok: true, status: 200, json: async () => ({ steps: f.steps }) };
        }
        const plan = { project: f.project, sub: f.sub, aspect: '9:16', scenes: f.scenes };
        if (method === 'studio_projects') result = [{ project: 'A', subs: ['video', 'other'] }];
        else if (method === 'studio_current') result = { project: f.project, sub: f.sub };
        else if (method === 'studio_select') { const b = JSON.parse(opts.body); f.project = b.project; f.sub = b.sub; }
        else if (method === 'studio_plan_read') result = structuredClone(plan);
        else if (method === 'studio_workflow_read') result = window.deriveWorkflow({ plan, scenes: f.scenes.map(s => ({ n: s.n, validPlan: true, validSource: true, storyboardExists: !!s.storyboard, clipExists: !!s.clip, hasTakes: false, hasActiveJob: false })), renderVersions: f.renders.map(r => r.version), editTaskPhase: null });
        else if (method === 'studio_status') (f.statusCalls = (f.statusCalls || 0) + 1), result = { scenes: f.scenes.map(s => ({ ...s, takes: [], jobs: f.jobs.filter(j => j.scene === s.n) })), pending: [], steps: f.steps, production_plan: { text: '', rev: '0' } };
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
    if (before) await page.evaluate(before);
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

  // ======== Gate bar ========
  // Steps from the current one on; earlier ones approved.
  const S = (over) => ({ idea: step('approved'), plan: step('approved'), look: step('approved'), assets: step('approved'), edit: step('approved'), ...over });
  const planSummary = 'Six scenes, two parts.\nNarration by Charon.\nEstimate: Look 40 credits, Assets 360 credits';
  const STATES = {
    working: S({ assets: { ...step('working'), budget: 400, spent: 50 }, edit: step('idle') }),
    review: sixSteps.steps,
    plan: S({ plan: { ...step('review'), summary: planSummary }, look: step('idle'), assets: step('idle'), edit: step('idle') }),
    blocked: S({ look: { ...step('blocked'), budget: 40, spent: 30, reservations: [{ job: 'a', credits: 10 }], blockedReason: 'needs 12 more credits' }, assets: step('idle'), edit: step('idle') }),
    paused: S({ assets: { ...step('working'), paused: true, budget: 400, spent: 50 }, edit: step('idle') }),
  };
  const setSteps = (page, steps) => page.evaluate(async (steps) => { const f = window.fixture; f.steps = { owner: 'flow-studio-steps-v1', rev: f.steps.rev + 1, steps }; f.posts = []; await refresh(true); }, steps);
  const posts = (page) => page.evaluate(() => window.fixture.posts);
  const ACTIONS = ['start', 'approve', 'ask-changes', 'resume', 'add-credits'];
  const shown = (page) => page.locator(ACTIONS.map(id => '#' + id).join(',')).evaluateAll(b => b.filter(x => x.checkVisibility()).map(x => x.id));
  const base = { project: 'A', sub: 'video' };
  {
    const { context, page, errors } = await open(1366);
    await page.evaluate(() => {
      window.notes = []; window.asked = 0;
      window.Notification = class { static permission = 'default'; static requestPermission() { window.asked++; return Promise.resolve('default'); } constructor(t, o) { window.notes.push(t + '|' + o.body); } };
    });
    // review: summary, counts, Approve and Ask for changes
    const gate = page.locator('#gate');
    await page.evaluate(() => refresh(true));
    assert.equal(await gate.isVisible(), true);
    assert.equal(await gate.getAttribute('data-status'), 'review');
    assert.equal(await page.locator('#gate-summary').innerText(), 'All six scenes made.\nScene 5 sleeve differs.');
    assert.equal(await page.locator('#gate-counts').innerText(), '6 scenes · 1 flagged · 61 of 400 credits');
    assert.equal(await page.locator('#gate-counts').evaluate(e => getComputedStyle(e).fontVariantNumeric), 'tabular-nums');
    assert.deepEqual(await shown(page), ['approve', 'ask-changes']);
    assert.equal(await page.locator('#approve').isEnabled(), true);
    assert.equal(await page.locator('#ask-changes').isEnabled(), true);
    assert.equal(await page.locator('#approve').innerText(), 'Approve');
    assert.equal(await page.locator('#gate').getAttribute('aria-label'), 'Review');
    assert.match(await page.locator('#gate-live').innerText(), /^Assets ready for review$/);
    assert.equal(await page.locator('#gate-live').getAttribute('aria-live'), 'polite');
    assert.equal(await page.evaluate(() => window.asked), 0, 'no permission prompt on load');
    // the agent's note for a flagged scene shows under the player
    await page.locator('#strip .tile[data-scene="5"]').click();
    assert.equal(await page.locator('#flag-note').isVisible(), true);
    assert.match(await page.locator('#flag-note').innerText(), /Sleeve colour differs/);
    assert.equal(await page.locator('#flag-note').getAttribute('aria-expanded'), 'false');
    await page.locator('#flag-note').click();
    assert.equal(await page.locator('#flag-note').getAttribute('aria-expanded'), 'true');
    await page.locator('#strip .tile[data-scene="4"]').click();
    assert.equal(await page.locator('#flag-note').isVisible(), false);

    // working: one progress line, no buttons; then review again: title and one notification
    await page.evaluate(() => { Notification.permission = 'granted'; });
    await setSteps(page, STATES.working);
    assert.equal(await gate.getAttribute('data-status'), 'working');
    assert.match(await page.locator('#gate-step').innerText(), /^\S+ Assets · working$/, 'icon plus label');
    assert.deepEqual(await shown(page), []);
    assert.equal(await page.locator('#gate-summary, #gate-counts, #budget-form, #changes-form').evaluateAll(e => e.filter(x => x.checkVisibility()).length), 0);
    assert.equal(await page.title(), 'Flow Studio');
    await page.screenshot({ path: shots9 + 'gate-working-1366.png' });
    await setSteps(page, sixSteps.steps);
    await page.evaluate(() => refresh(true));
    assert.equal(await page.title(), '● Review — video');
    assert.deepEqual(await page.evaluate(() => window.notes), ['Review — video|Assets ready for review'], 'one notification, video and step names only');
    await setSteps(page, STATES.blocked);
    assert.equal(await page.title(), '● Review — video');
    assert.equal(await page.evaluate(() => window.notes.length), 2);

    // approve: one request on a double click, buttons disabled while pending
    await setSteps(page, sixSteps.steps);
    await page.evaluate(() => { window.fixture.hold = new Promise(r => { window.release = r; }); });
    await page.locator('#approve').dblclick();
    assert.equal(await page.locator('#approve').isDisabled(), true);
    assert.equal(await page.locator('#ask-changes').isDisabled(), true);
    await page.evaluate(() => { window.release(); window.fixture.hold = null; });
    await page.waitForFunction(() => !$('approve').disabled);
    assert.deepEqual(await posts(page), [{ ...base, step: 'assets', action: 'approve' }]);
    assert.equal(await page.evaluate(() => window.asked), 0, 'permission already granted: not asked');
    // a 409 shows the server's message as text and re-enables the buttons
    await page.evaluate(() => { window.fixture.replies = [{ status: 409, error: '<b>Assets</b> is not ready for review.' }]; });
    await page.locator('#approve').click();
    await page.waitForFunction(() => $('gate-error').textContent && !$('approve').disabled);
    assert.equal(await page.locator('#gate-error').innerText(), '<b>Assets</b> is not ready for review.');
    assert.equal(await page.locator('#gate-error b').count(), 0);
    assert.equal(await page.locator('#ask-changes').isEnabled(), true);

    // ask for changes: empty text keeps Send disabled; a pin carries the scene, or the time on a render
    await setSteps(page, sixSteps.steps);
    await page.locator('#strip .tile[data-scene="5"]').click();
    await page.locator('#ask-changes').click();
    assert.equal(await page.locator('#changes-form').isVisible(), true);
    assert.equal(await page.locator('#ask-changes').getAttribute('aria-expanded'), 'true');
    assert.equal(await page.locator('#changes-form textarea').getAttribute('maxlength'), '2000');
    assert.equal(await page.locator('#send-changes').isDisabled(), true);
    await page.locator('#changes-form textarea').fill('   ');
    assert.equal(await page.locator('#send-changes').isDisabled(), true);
    await page.locator('#changes-form textarea').fill('Make the sleeve red');
    assert.equal(await page.getByLabel('Pin to this scene').isVisible(), true);
    await page.locator('#pin-scene').check();
    await page.locator('#send-changes').click();
    await page.waitForFunction(() => window.fixture.posts.length === 1 && !$('approve').disabled);
    assert.deepEqual(await posts(page), [{ ...base, step: 'assets', action: 'changes', text: 'Make the sleeve red', scene: 5 }]);
    assert.equal(await page.locator('#changes-form').isVisible(), false, 'form closes once sent');
    await page.evaluate(async () => { window.fixture.renders = [{ version: 1, path: 'v1.mp4' }]; selectScene(null); await refresh(true); });
    await page.locator('#player video').evaluate(v => Object.defineProperty(v, 'currentTime', { value: 12.34 }));
    await page.locator('#ask-changes').click();
    assert.equal(await page.locator('#changes-form textarea').inputValue(), '', 'sent text is cleared');
    assert.equal(await page.getByLabel('Pin to this moment').isVisible(), true);
    await page.locator('#changes-form textarea').fill('Cut the pause');
    await page.locator('#pin-scene').check();
    await page.locator('#send-changes').click();
    await page.waitForFunction(() => window.fixture.posts.length === 2);
    assert.deepEqual((await posts(page))[1], { ...base, step: 'assets', action: 'changes', text: 'Cut the pause', at: 12.3 });
    await page.evaluate(async () => { window.fixture.renders = []; await refresh(true); });
    await page.locator('#ask-changes').click();
    await page.locator('#changes-form textarea').fill('Warmer light');
    await page.screenshot({ path: shots9 + 'gate-changes-1366.png' });
    await page.locator('#send-changes').click();
    await page.waitForFunction(() => window.fixture.posts.length === 3);
    assert.deepEqual((await posts(page))[2], { ...base, step: 'assets', action: 'changes', text: 'Warmer light' }, 'unpinned: no scene, no time');

    // Plan gate: budgets pre-filled from the estimate line; empty or negative blocks approve
    await setSteps(page, STATES.plan);
    assert.equal(await page.locator('#approve').innerText(), 'Approve and set budgets');
    assert.equal(await page.locator('#budget-form').isVisible(), true);
    assert.equal(await page.locator('#budget-look').inputValue(), '40');
    assert.equal(await page.locator('#budget-assets').inputValue(), '360');
    for (const bad of ['', '-5', '2.5']) {
      await page.locator('#budget-look').fill(bad);
      await page.locator('#approve').click();
      assert.equal(await page.locator('#gate-error').innerText(), 'Enter both budgets');
      assert.deepEqual(await posts(page), []);
    }
    // values read as values, with a unit, capped at 100000
    assert.equal(await page.locator('#budget-look').evaluate(e => getComputedStyle(e).color), await page.locator('#gate-step').evaluate(e => getComputedStyle(e).color));
    assert.match(await page.locator('#budget-form').innerText(), /Look\s+credits[\s\S]*Assets\s+credits/);
    assert.equal(await page.locator('#budget-look').getAttribute('max'), '100000');
    await page.locator('#budget-look').fill('100001');
    await page.locator('#approve').click();
    assert.equal(await page.locator('#gate-error').innerText(), 'Up to 100000 credits');
    assert.deepEqual(await posts(page), []);
    await page.locator('#budget-look').fill('50');
    await page.locator('#approve').click();
    await page.waitForFunction(() => window.fixture.posts.length === 1 && !$('approve').disabled);
    assert.deepEqual(await posts(page), [{ ...base, step: 'plan', action: 'approve', budgets: { look: 50, assets: 360 } }]);
    assert.equal(await page.locator('#gate-error').innerText(), '');
    const noEstimate = S({ plan: { ...step('review'), summary: 'Plan ready.\nSix scenes.\nEstimate: about 400' }, look: step('idle'), assets: step('idle'), edit: step('idle') });
    await setSteps(page, noEstimate);
    assert.equal(await page.locator('#budget-look').inputValue(), '');
    assert.equal(await page.locator('#budget-assets').inputValue(), '');
    await setSteps(page, S({ plan: { ...step('review'), summary: 'Plan ready.\nSix scenes.\nEstimate: Look 40 credits, Assets 99999999999999999999 credits' }, look: step('idle'), assets: step('idle'), edit: step('idle') }));
    assert.equal(await page.locator('#budget-look').inputValue(), '', 'an absurd estimate pre-fills nothing');
    assert.equal(await page.locator('#budget-assets').inputValue(), '');

    // blocked on budget: Add credits posts budget (budget + N) then resume
    await setSteps(page, STATES.blocked);
    assert.equal(await gate.getAttribute('data-status'), 'blocked');
    assert.deepEqual(await shown(page), ['add-credits']);
    assert.equal(await page.locator('#gate-summary').innerText(), 'needs 12 more credits');
    assert.equal(await page.locator('#credits-budget').inputValue(), '52');
    assert.match(await page.locator('#credits-label').innerText(), /credits/);
    await page.locator('#credits-budget').fill('100001');
    await page.locator('#add-credits').click();
    assert.equal(await page.locator('#gate-error').innerText(), 'Up to 100000 credits');
    assert.deepEqual(await posts(page), []);
    await page.locator('#credits-budget').fill('52');
    await page.locator('#add-credits').click();
    await page.waitForFunction(() => window.fixture.posts.length === 2);
    assert.deepEqual(await posts(page), [{ ...base, step: 'look', action: 'budget', credits: 52 }, { ...base, step: 'look', action: 'resume' }]);
    // a refused budget never resumes
    await page.evaluate(() => { window.fixture.replies = [{ status: 409, error: 'Budget cannot be below 40 credits already spent or reserved.' }]; });
    await page.locator('#add-credits').click();
    await page.waitForFunction(() => $('gate-error').textContent && !$('add-credits').disabled);
    assert.deepEqual((await posts(page)).map(p => p.action), ['budget', 'resume', 'budget']);
    // blocked for another reason: the reason and Resume only
    await setSteps(page, S({ look: { ...step('blocked'), blockedReason: 'Flow is signed out.' }, assets: step('idle'), edit: step('idle') }));
    assert.deepEqual(await shown(page), ['resume']);
    assert.equal(await page.locator('#gate-summary').innerText(), 'Flow is signed out.');

    // paused: only Resume
    await setSteps(page, STATES.paused);
    assert.equal(await gate.getAttribute('data-status'), 'paused');
    assert.deepEqual(await shown(page), ['resume']);
    await page.locator('#resume').click();
    await page.waitForFunction(() => window.fixture.posts.length === 1);
    assert.deepEqual(await posts(page), [{ ...base, step: 'assets', action: 'resume' }]);

    // idle and startable: Start posts start for that step
    await setSteps(page, S({ idea: step('idle'), plan: step('idle'), look: step('idle'), assets: step('idle'), edit: step('idle') }));
    assert.equal(await gate.getAttribute('data-status'), 'idle');
    assert.deepEqual(await shown(page), ['start']);
    await page.locator('#start').click();
    await page.waitForFunction(() => window.fixture.posts.length === 1);
    assert.deepEqual(await posts(page), [{ ...base, step: 'idea', action: 'start' }]);
    // nothing asked of the owner: no bar
    await setSteps(page, S({}));
    assert.equal(await gate.isVisible(), false);
    assert.equal(await page.title(), 'Flow Studio');
    // a long summary is clamped to three lines with the full text on expand
    await setSteps(page, S({ edit: { ...step('review'), summary: Array(30).fill('A long line of agent text').join(' ') } }));
    const more = page.locator('#gate-more');
    assert.equal(await more.isVisible(), true);
    const clamped = await page.locator('#gate-summary').evaluate(e => e.clientHeight);
    await more.click();
    assert.ok(await page.locator('#gate-summary').evaluate(e => e.clientHeight) > clamped, 'expands');
    // offline disables the gate's write controls
    await setSteps(page, sixSteps.steps);
    await page.evaluate(async () => { window.fixture.offline = true; await refresh(true); });
    assert.equal(await page.locator('#approve').isDisabled(), true);
    await page.evaluate(async () => { window.fixture.offline = false; await refresh(true); });
    assert.equal(await page.locator('#approve').isEnabled(), true);
    assert.deepEqual(errors, []);
    await context.close();
  }
  // The gate acts only on the video it was drawn for; switching videos clears it; a hidden window still hears about review.
  {
    const stub = (permission) => `(${(permission) => {
      window.notes = []; window.asked = 0;
      window.Notification = class { static permission = permission; static requestPermission() { window.asked++; return Promise.resolve(permission); } constructor(t, o) { window.notes.push(t + '|' + o.body); } };
    }})(${JSON.stringify(permission)})`;
    const { context, page, errors } = await open(1366, '1', stub('granted'));
    const settled = () => page.waitForFunction(() => !$('gate').hidden && !$('approve').disabled || !$('add-credits').hidden && !$('add-credits').disabled);
    const agentSwitch = (sub) => page.evaluate(async (sub) => { window.fixture.sub = sub; await refresh(true); }, sub);
    // first load of a step already in review: title, no notification
    assert.equal(await page.title(), '● Review — video');
    assert.deepEqual(await page.evaluate(() => window.notes), [], 'first load never notifies');
    // the selection changed under a drawn gate: nothing is sent, one line, redrawn for the new video
    await page.evaluate(() => { $('sub').value = 'other'; });
    await page.locator('#approve').click();
    await page.waitForFunction(() => $('gate-error').textContent === 'Video changed. Review again.' && !$('gate').hidden && document.title === '● Review — other');
    assert.deepEqual(await posts(page), []);
    assert.equal(await page.title(), '● Review — other');
    await page.evaluate(() => { $('sub').value = 'video'; $('sub').dispatchEvent(new Event('change')); });
    await settled();
    assert.equal(await page.locator('#gate-error').innerText(), '', 'a new video starts with no message');
    // an agent switch closes the open form and discards its draft
    await page.locator('#ask-changes').click();
    await page.locator('#changes-form textarea').fill('Text for the old video');
    await agentSwitch('other');
    await settled();
    assert.equal(await page.locator('#changes-form').isVisible(), false);
    assert.equal(await page.locator('#ask-changes').getAttribute('aria-expanded'), 'false');
    assert.equal(await page.locator('#changes-form textarea').inputValue(), '');
    assert.deepEqual(await posts(page), []);
    await agentSwitch('video');
    await settled();
    // a switch while Add credits is pending: the budget went to the old video, no resume follows, nothing is applied
    await setSteps(page, STATES.blocked);
    await page.evaluate(() => { window.fixture.hold = new Promise(r => { window.release = r; }); });
    await page.locator('#add-credits').click();
    await agentSwitch('other');
    await page.evaluate(() => { window.release(); window.fixture.hold = null; });
    await settled();
    await page.waitForTimeout(200);
    assert.deepEqual(await posts(page), [{ ...base, step: 'look', action: 'budget', credits: 52 }]);
    assert.equal(await page.locator('#gate-error').innerText(), '');
    // a refusal that returns after the switch is not shown on the new video
    await agentSwitch('video');
    await setSteps(page, sixSteps.steps);
    await page.evaluate(() => { window.fixture.hold = new Promise(r => { window.release = r; }); window.fixture.replies = [{ status: 409, error: 'Assets is not ready for review.' }]; });
    await page.locator('#approve').click();
    await agentSwitch('other');
    await page.evaluate(() => { window.release(); window.fixture.hold = null; });
    await settled();
    await page.waitForTimeout(200);
    assert.deepEqual(await posts(page), [{ ...base, step: 'assets', action: 'approve' }]);
    assert.equal(await page.locator('#gate-error').innerText(), '');
    await agentSwitch('video');
    // hidden window: polls every 15 s while a step works, so the title and one notification still arrive
    await page.evaluate(() => Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' }));
    await setSteps(page, STATES.working);
    await page.evaluate(() => { window.notes = []; window.fixture.steps = { ...window.fixture.steps, steps: structuredClone(window.fixture.steps.steps) }; window.fixture.steps.steps.assets.status = 'review'; });
    await page.waitForFunction(() => document.title === '● Review — video', null, { timeout: 20000 });
    assert.deepEqual(await page.evaluate(() => window.notes), ['Review — video|Assets ready for review']);
    const calls = await page.evaluate(() => window.fixture.statusCalls);
    await page.evaluate(() => hiddenPoll());
    await page.waitForTimeout(300);
    assert.equal(await page.evaluate(() => window.fixture.statusCalls), calls, 'nothing working: no hidden poll');
    assert.deepEqual(errors, []);
    await context.close();
    // permission is asked on the first gate click, once, never on load
    const second = await open(1366, '1', stub('default'));
    assert.equal(await second.page.evaluate(() => window.asked), 0);
    await second.page.locator('#ask-changes').click();
    await second.page.locator('#ask-changes').click();
    assert.equal(await second.page.evaluate(() => window.asked), 1);
    assert.deepEqual(second.errors, []);
    await second.context.close();
  }
  // non-owner window: no gate write control works, one alert
  {
    const { context, page, errors } = await open(1366, '');
    for (const [steps, ids] of [[sixSteps.steps, ['approve', 'ask-changes']], [STATES.paused, ['resume']], [STATES.blocked, ['add-credits']]]) {
      await setSteps(page, steps);
      for (const id of ids) assert.equal(await page.locator('#' + id).isDisabled(), true, id + ' disabled');
    }
    assert.equal(await page.locator('#send-changes').isDisabled(), true);
    assert.equal(await page.locator('#resume').isDisabled(), true);
    await setSteps(page, sixSteps.steps);
    assert.equal(await page.locator('#approve').isDisabled(), true);
    assert.match(await page.locator('#alerts').getAttribute('aria-label'), /^Alerts: 1,/);
    assert.deepEqual(errors, []);
    await context.close();
  }
  // both widths: 44px targets at 480, no sideways scroll, a look at each state
  for (const width of [1366, 480]) {
    const { context, page, errors } = await open(width);
    for (const [name, steps] of Object.entries(STATES)) {
      await setSteps(page, steps);
      if (name === 'review') await page.locator('#ask-changes').click();
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), name + ': no horizontal page scroll');
      if (width === 480) for (const b of await page.locator('#gate :is(button, input:not([type=checkbox]), textarea, .gate-pin):visible').all()) {
        const box = await b.boundingBox();
        assert.ok(box.height >= 44, `${name}: ${await b.getAttribute('id') || 'pin label'} is ${box.height}px tall`);
      }
      await page.screenshot({ path: shots9 + `gate-${name === 'review' ? 'changes' : name}-${width}.png` });
      if (name === 'review') { await page.locator('#ask-changes').click(); await page.screenshot({ path: shots9 + `gate-review-${width}.png` }); }
    }
    assert.deepEqual(errors, []);
    await context.close();
  }
  console.log('Gate bar: review, working, notifications, approve once, 409, changes with pins, Plan budgets, Add credits, resume, start, clamp, offline, video-switch scope guard, first-load and hidden-window notifications, non-owner and 44px targets passed.');
} finally { await browser.close(); }
