import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { chromeExecutable } from '../dist/chrome.js';
import { deriveWorkflow } from '../dist/workflow.js';
import { readCreativeGuide } from '../dist/creative-guide.js';

const root = fileURLToPath(new URL('../../', import.meta.url));
const stageGuides = Object.fromEntries(['ideas','plan','storyboard'].map(stage=>[stage,readCreativeGuide(stage)]));
const html = readFileSync(root + 'ui/index.html', 'utf8').replace(/<script[^>]*>[\s\S]*?<\/script>/g, '').replace(/<link[^>]*>/g, '').replace('__FLOW_TOKEN__', 'fixture').replace('__OWNER__', '1');
const browser = await chromium.launch({ executablePath: process.env.FLOW_TEST_CHROME ?? chromeExecutable(), headless: true });
try {
  for (const width of [1366, 1024, 480]) {
    const context = await browser.newContext({ viewport: { width, height: 850 } });
    const page = await context.newPage(), errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.route('**/*', (r) => r.request().url() === 'http://workflow.test/' ? r.fulfill({ contentType: 'text/html', body: html }) : r.abort());
    await page.goto('http://workflow.test/');
    await page.addStyleTag({ content: readFileSync(root + 'ui/studio.css', 'utf8') });
    await page.addScriptTag({ content: 'window.deriveWorkflow = ' + deriveWorkflow.toString() });
    await page.addStyleTag({ content: readFileSync(root + 'engine/node_modules/@xterm/xterm/css/xterm.css', 'utf8') });
    for (const file of ['@xterm/xterm/lib/xterm.js', '@xterm/addon-fit/lib/addon-fit.js'])
      await page.addScriptTag({ content: readFileSync(root + 'engine/node_modules/' + file, 'utf8') });
    await page.evaluate((guides) => {
      const f = window.fixture = { project: 'A', sub: 'ad', newCuts: {}, adSelections: {'A/ad':['shared.png']}, projectRefs:{A:['shared.png'],B:[]}, localRefs:{A:['added.png'],B:[]}, notes: { A: 'saved A', B: 'saved B' }, revisions: { A: 1, B: 1 }, saves: [], calls: [], jobs: [], tasks: {}, renders: [], scenes: [{ n: 1, prompt: 'fixture', approved: false }], sent: [], projects: ['A', 'B'] };
      window.WebSocket = class {
        readyState = 0;
        constructor() { f.socket = this; setTimeout(() => { this.readyState = 1; this.onopen?.(); this.onmessage?.({ data: JSON.stringify({ t: 'agent', agent: 'codex', status: 'running', session: 1 }) }); }, 10); }
        send(raw) { const m = JSON.parse(raw); f.sent.push(m); if (m.t === 'input-mode') this.onmessage?.({data: JSON.stringify(m)}); if (m.t === 'submit-message') setTimeout(() => this.onmessage?.({data: JSON.stringify({t:'message-delivery', requestId:m.requestId, state:'forwarded'})}), 10); }
      };
      window.fetch = async (url, opts) => {
        if (f.offline) throw new Error('Fixture offline');
        if (f.expired) return { ok: false, status: 401, json: async () => ({ error: 'Expired token' }) };
        const method = String(url).split('/').pop(), body = typeof opts?.body === 'string' ? JSON.parse(opts.body) : {}, p = body.project || f.project;
        const sub = body.sub || f.sub, key=p+'/'+sub, cut = f.newCuts[key], selected=f.adSelections[key];
        f.calls.push({ method, body }); let result = {};
        if (method === 'studio_projects') result = f.projects.map((project) => ({ project, subs: ['ad', ...Object.values(f.newCuts).filter(c=>c.project===project).map(c=>c.sub)] }));
        else if (method === 'studio_guide_read') result = guides[body.stage];
        else if (method === 'studio_new') { if (body.sub === 'ad' || f.newCuts[p+'/'+body.sub]) result = {error:'Already exists'}; else f.newCuts[p+'/'+body.sub] = {project:p,sub:body.sub,aspect:body.aspect,references:[],scenes:[]}; }
        else if (method === 'studio_select') { f.project = body.project; f.sub = body.sub; }
        else if (method === 'studio_current') result = f.projects.length ? { project: f.project, sub: f.sub } : null;
        else if (method === 'studio_plan_read') result = structuredClone(cut || { project: p, sub, aspect: '9:16', scenes: f.scenes, ...(selected===undefined?{}:{references:selected}) });
        else if (method === 'studio_plan_write') { if(cut) Object.assign(cut,body.plan);else{f.adSelections[key]=body.plan.references;f.scenes=body.plan.scenes;}result={ok:true}; }
        else if (method === 'studio_workflow_read') result = window.deriveWorkflow({plan:cut||{project:p,sub,aspect:'9:16',scenes:f.scenes},scenes:(cut?.scenes||f.scenes).map(s=>({n:s.n,validPlan:!!s.prompt?.trim(),validSource:true,storyboardExists:!!s.storyboard,clipExists:!!s.clip,hasTakes:!!s.takes?.length,hasActiveJob:!!f.jobs.length})),renderVersions:cut?[]:f.renders.map(r=>r.version),editTaskPhase:cut?null:f.tasks[p]?.phase??null});
        else if (method === 'studio_notes_read' || method === 'studio_edit_notes_read') result = { text: f.notes[p], rev: String(f.revisions[p]) };
        else if (method === 'studio_notes_write' || method === 'studio_edit_notes_write') {
          if (body.rev !== String(f.revisions[p])) return { ok: false, status: 400, json: async () => ({ error: 'Notes changed' }) };
          f.notes[p] = body.text; f.saves.push(p); result = { rev: String(++f.revisions[p]) };
        } else if (method === 'studio_references') { const shared=f.projectRefs[p]||[],local=f.localRefs[p]||[],active=cut?.references??selected??[]; result={project:shared,sub:local,active,library:[...shared,...local].filter(r=>!active.includes(r))}; }
        else if (method === 'studio_status') result = { scenes: f.scenes.map((s) => ({ ...s, jobs: f.jobs, takes: s.takes || [] })), pending: [] };
        else if (method === 'scene') { const scene = f.scenes.find((s) => s.n === body.n); Object.assign(scene, body); }
        else if (method === 'studio_generate') {
          result = f.jobs.length ? { held: 0, already_queued: [1] } : { held: 1, already_queued: [] };
          if (!f.jobs.length) f.jobs.push({ id: 'job', kind: 'clip', status: 'held', batch: 'fixture' });
        } else if (method === 'take') { f.scenes[0].clip = body.clip; f.scenes[0].kept = false; }
        else if (method === 'studio_edit_task_read') result = { task: f.tasks[p] || null };
        else if (method === 'studio_renders') result = { renders: f.renders };
        else if (String(url).endsWith('/edit-task/start')) {
          if (f.tasks[p] && !['finished', 'failed'].includes(f.tasks[p].phase)) result = { error: 'Already active' };
          else result = { task: f.tasks[p] = { id: 'task-' + f.calls.length, phase: 'sent', message: 'Waiting for acknowledgement' } };
        } else if (String(url).endsWith('/edit-task/stop')) result = { task: f.tasks[p] = { ...f.tasks[p], phase: 'failed', message: 'Marked stopped' } };
        else if (method === 'accounts' || method === 'pending') result = [];
        return { ok: !result?.error, status: result?.error ? 400 : 200, json: async () => result };
      };
    }, stageGuides);
    await page.addScriptTag({ content: readFileSync(root + 'ui/app.js', 'utf8') });
    await page.waitForFunction(() => !!data.workflow);
    const initialInputs = await page.evaluate(() => window.fixture.sent.filter(m => m.t === 'i' || m.t === 'submit-message').length);
    assert.equal(await page.getByRole('tab', {name:'5 Edit'}).getAttribute('aria-disabled'), 'true');
    await page.getByRole('tab', {name:'5 Edit'}).click({force:true});
    assert.notEqual(await page.evaluate(() => view), 'edit', 'locked future stage cannot open');
    await page.getByRole('tab', { name: '2 Plan' }).click();
    await page.waitForFunction(() => document.querySelector('#notes')?.value === 'saved A');
    assert.equal(await page.locator('#view-plan .creative-guide').count(),1,'plan shows the owner guide basis');
    await page.locator('#view-plan .creative-guide summary').click();
    await page.getByRole('button',{name:'Remove shared.png from this ad',exact:true}).click();
    await page.waitForFunction(()=>window.fixture.adSelections['A/ad']?.length===0);
    assert.equal(await page.getByRole('button',{name:'Remove shared.png from this ad',exact:true}).count(),0);
    await page.locator('#view-plan summary').filter({hasText:'Reference library'}).click();
    await page.getByRole('button',{name:'Use added.png for this ad',exact:true}).click();
    await page.waitForFunction(()=>window.fixture.adSelections['A/ad']?.includes('added.png'));
    await page.getByRole('button',{name:'Remove added.png from this ad',exact:true}).click();
    await page.waitForFunction(()=>window.fixture.adSelections['A/ad']?.length===0);
    assert.deepEqual(await page.evaluate(()=>window.fixture.projectRefs.A),['shared.png'],'removal preserves stored library references');
    await page.evaluate(async()=>{window.fixture.scenes[0].references=['scene.png'];await refresh(true);});
    await page.getByRole('button',{name:'Remove scene 1 reference scene.png',exact:true}).click();
    await page.waitForFunction(()=>window.fixture.scenes[0].references.length===0);
    assert.ok((await page.locator('#view-plan .creative-guide').innerText()).trim().length > 0, 'the guide shows its text');
    await page.evaluate(async()=>{await refresh(true);});
    assert.equal(await page.locator('#view-plan .creative-guide').getAttribute('open'),'','guide stays open during refresh');
    await page.locator('#view-plan .creative-guide summary').click();
    await page.locator('#notes').fill('draft A');
    await page.waitForFunction(() => window.fixture.notes.A === 'draft A');
    await page.waitForTimeout(100);
    assert.ok(await page.locator('#notes').evaluate((el) => document.activeElement === el), 'autosave preserves focus');
    await page.locator('#project').selectOption('B');
    await page.waitForFunction(() => data.workflow?.project === 'B');
    await page.getByRole('tab', {name:'2 Plan'}).click();
    await page.waitForFunction(() => document.querySelector('#notes')?.value === 'saved B');
    await page.locator('#project').selectOption('A');
    await page.waitForFunction(() => document.querySelector('#notes')?.value === 'draft A');
    await page.locator('#notes').fill('independent A');
    await page.locator('#project').selectOption('B');
    await page.waitForFunction(() => document.querySelector('#notes')?.value === 'saved B');
    await page.locator('#notes').fill('independent B');
    await page.waitForFunction(() => window.fixture.notes.A === 'independent A' && window.fixture.notes.B === 'independent B');
    await page.locator('#project').selectOption('A');
    await page.waitForFunction(() => document.querySelector('#notes')?.value === 'independent A');
    await page.locator('#notes').fill('recoverable draft');
    assert.equal(await page.evaluate(async () => { document.activeElement.blur(); const fresh = makeNotes('notes', 'Notes', 'studio_notes_read', 'studio_notes_write'); await fresh.load(); return fresh.text['A/ad']; }), 'recoverable draft', 'local draft survives a new notes controller');
    await page.waitForFunction(() => window.fixture.notes.A === 'recoverable draft');
    await page.getByRole('tab', { name: '3 Storyboard' }).click();
    await page.waitForFunction(() => !!document.querySelector('#view-storyboard button'));
    assert.ok((await page.locator('#view-storyboard .creative-guide').innerText()).includes('Creative basis'));
    assert.ok((await page.locator('#view-storyboard').innerText()).includes('Selected references: none'),'storyboard makes the effective reference selection visible');
    assert.equal(await page.getByRole('button', { name: 'Approve scene', exact: true }).isEnabled(), false);
    await page.evaluate(async () => { window.fixture.scenes[0].storyboard = 'fixture.png'; await refresh(true); });
    await page.getByRole('button', { name: 'Approve scene', exact: true }).click();
    await page.waitForFunction(() => window.fixture.scenes[0].approved === true);
    await page.getByRole('tab', { name: '2 Plan' }).click();
    await page.getByRole('button', { name: 'Scene 1', exact: true }).click();
    await page.getByRole('button', { name: 'Message', exact: true }).click();
    await page.locator('#message-input').fill('Shorten this scene');
    await page.locator('#message-ready').check();
    await page.getByRole('button', {name:'Send with context'}).click();
    await page.getByRole('tab', {name:'3 Storyboard'}).click();
    await page.waitForFunction(() => document.querySelector('#message-status').textContent.includes('Forwarded'));
    assert.ok(await page.evaluate(() => window.fixture.sent.some(m => m.t === 'submit-message' && m.context.stage === 'plan' && m.context.selection.scene === 1 && m.text === 'Shorten this scene')), 'message target survives later navigation');
    await page.getByRole('tab', { name: '4 Generate' }).click();
    await page.getByRole('button', { name: 'Queue approved scenes (held)', exact: true }).click();
    await page.waitForFunction(() => window.fixture.jobs.length === 1);
    await page.getByRole('button', { name: 'Queue approved scenes (held)', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('#toast').textContent.includes('Already queued'));
    await page.evaluate(async () => { const f = window.fixture; f.jobs = []; Object.assign(f.scenes[0], { clip: 'take2.mp4', takes: [{ clip: 'take1.mp4' }, { clip: 'take2.mp4' }] }); await refresh(true); });
    await page.locator('#view-generate summary').click();
    await page.getByRole('button', { name: 'Use this take', exact: true }).click();
    await page.waitForFunction(() => window.fixture.scenes[0].clip === 'take1.mp4');
    await page.evaluate(async () => { window.fixture.scenes[0].kept = true; await refresh(true); });
    await page.getByRole('tab', { name: '5 Edit' }).click();
    assert.equal(await page.evaluate(() => window.fixture.sent.filter(m => m.t === 'i' || m.t === 'submit-message').length), initialInputs + 1, 'navigation does not send additional messages');
    await page.waitForFunction(() => document.querySelector('#view-edit button.big')?.disabled === false);
    await page.getByRole('button', {name:'Message', exact:true}).click();
    await page.locator('#message-ready').check();
    await page.getByRole('button', { name: 'Edit video', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('#view-edit').textContent.includes('Edit task: sent'));
    assert.equal(await page.getByRole('button', { name: 'Edit video', exact: true }).isDisabled(), true);
    assert.ok(await page.evaluate(() => window.fixture.sent.some((m) => m.t === 'submit-message' && m.text.includes('studio_edit_task_update') && m.text.includes(window.fixture.tasks.A.id) && m.context.stage === 'edit')));
    for (const phase of ['accepted', 'editing', 'rendering']) {
      await page.evaluate(async (phase) => { window.fixture.tasks.A.phase = phase; window.fixture.tasks.A.message = phase + ' in progress'; await refresh(true); }, phase);
      assert.ok((await page.locator('#view-edit').innerText()).includes('Edit task: ' + phase));
    }
    await page.evaluate(async () => { window.fixture.tasks.A.phase = 'finished'; window.fixture.tasks.A.message = 'Render v1 is ready to review.'; window.fixture.renders = [{ version: 1, path: 'v1.mp4' }]; await refresh(true); });
    assert.equal(await page.getByRole('button', { name: 'Revise', exact: true }).isEnabled(), true);
    await page.evaluate(async () => { window.fixture.scenes[0].stale = 2; await refresh(true); });
    assert.equal(await page.getByRole('button', {name:'Revise',exact:true}).isDisabled(),true,'new edits blocked after stale source');
    assert.equal(await page.locator('#view-edit video.render').count(),1,'earlier render remains reviewable');
    await page.getByRole('tab',{name:'2 Plan'}).click();
    await page.getByRole('tab',{name:'5 Edit'}).click();
    assert.equal(await page.locator('#view-edit video.render').count(),1,'backward revision retains review access');
    await page.evaluate(async () => { delete window.fixture.scenes[0].stale; await refresh(true); });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1),'no horizontal page overflow');
    await page.locator('#toast').evaluate(el => el.hidden = true);
    await page.locator('main').evaluate(el => el.scrollTop = 0);
    await page.locator('#views').evaluate((el) => { el.scrollTop = 0; });
    await page.screenshot({ path: root + `.tmp/workflow-${width}.png` });
    await page.evaluate(async () => { window.fixture.offline = true; await refresh(true); });
    assert.equal(await page.locator('#connection').isVisible(), true);
    assert.equal(await page.getByRole('button', { name: 'Revise', exact: true }).isDisabled(), true);
    await page.evaluate(() => { window.fixture.offline = false; });
    await page.getByRole('button', { name: 'Retry connection', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('#connection').hidden === true);
    await page.evaluate(async () => { window.fixture.expired = true; await refresh(true); });
    assert.ok((await page.locator('#connection').innerText()).includes('Reload'));
    await page.evaluate(async () => { window.fixture.expired = false; await refresh(true); });
    const beforeNewAd = await page.evaluate(()=>({sent:window.fixture.sent.length,scenes:JSON.stringify(window.fixture.scenes),renders:JSON.stringify(window.fixture.renders)}));
    await page.locator('#view-edit').getByRole('button',{name:'Start new ad',exact:true}).click();
    assert.equal(await page.locator('#new-project-name').inputValue(),'A');
    assert.equal(await page.locator('#new-sub-name').inputValue(),'ad-01');
    await page.getByRole('button',{name:'Create ad',exact:true}).click();
    await page.waitForFunction(()=>view==='ideas' && data.plan?.sub==='ad-01' && data.plan.scenes.length===0);
    assert.deepEqual(await page.evaluate(()=>data.plan.references),[],'new cut has no inherited ad references');
    assert.equal(await page.getByRole('tab',{name:'2 Plan'}).getAttribute('aria-disabled'),'true');
    assert.deepEqual(await page.evaluate(()=>({scenes:JSON.stringify(window.fixture.scenes),renders:JSON.stringify(window.fixture.renders)})),{scenes:beforeNewAd.scenes,renders:beforeNewAd.renders},'finished ad and renders stay intact');
    assert.ok(await page.evaluate(()=>!window.fixture.sent.some(m=>m.t==='restart'||m.t==='agent')),'starting an ad preserves the chat session');
    await page.locator('#sub').selectOption('ad');
    await page.waitForFunction(()=>view==='edit' && data.plan?.sub==='ad');
    assert.equal(await page.locator('#view-edit video.render').count(),1,'finished ad can be reopened');
    assert.deepEqual(errors, []);
    console.log(`Workflow ${width}px: note focus/drafts, independent saves, approval requirements, duplicate feedback, take restoration, edit lifecycle and offline recovery passed.`);
    await context.close();
  }
} finally { await browser.close(); }
