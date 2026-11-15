import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { chromeExecutable } from '../dist/chrome.js';
import { activeAccount, ensureJobProject, accountId } from '../dist/switcher.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Standalone fixtures only: no CDP connection, real profile, network or generation.
const browser = await chromium.launch({ executablePath: process.env.FLOW_TEST_CHROME ?? chromeExecutable(), headless: true });
const scratch = mkdtempSync(join(tmpdir(), 'flow-identity-'));
try {
  const page = await browser.newPage();
  await page.route('**/*', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><html lang="en"><body></body></html>' }));
  await page.goto('https://flow.google.com/u/2/project/11111111-1111-1111-1111-111111111111');
  await page.setContent('<button aria-label="Google account: Person&#10;person@example.test">Profile</button>');
  assert.equal(await activeAccount(page), 'person@example.test', 'current account label must be recognized');

  const fixture = email => `<button aria-label="Account details" onclick="document.querySelector('section').hidden=false;window.opens++">Account</button>
    <div class="ProseMirror">Unrelated prompt: wrong@example.test</div>
    <section hidden><button aria-label="Close account panel" onclick="document.querySelector('section').hidden=true">Close</button>
    <p>${email}</p><a href="#">50 Google Flow credits</a><p>Credits refresh daily at 8:22 AM</p></section>
    <script>window.opens=0;</script>`;
  await page.setContent(fixture('person@example.test'));
  assert.equal(await activeAccount(page), undefined, 'passive health reads must not open the account panel');
  assert.equal(await page.evaluate(() => window.opens), 0);
  assert.equal(await activeAccount(page, true), 'person@example.test', 'generation preflight can read the account panel identity');
  assert.equal(await page.locator('section').isVisible(), false, 'account panel is closed after inspection');
  const job = { flow: { account: accountId('person@example.test'), flowProject: '/project/11111111-1111-1111-1111-111111111111' }, params: { type: 'video', agent_ref_assets: ['cached'] } };
  await ensureJobProject(page, job, join(scratch, 'projects.json'));
  await assert.rejects(ensureJobProject(page, { ...job, flow: { ...job.flow, account: accountId('other@example.test') } }, join(scratch, 'projects.json')), /source project could not be verified/i);
  assert.equal(await page.locator('section').isVisible(), false);

  await page.setContent(fixture('person@example.test other@example.test'));
  assert.equal(await activeAccount(page, true), undefined, 'ambiguous account identity must fail closed');
  await assert.rejects(ensureJobProject(page, { params: { type: 'video' } }), /could not verify the active Google account/i);
  assert.equal(await page.locator('section').isVisible(), false);
  await page.setContent(fixture('50 credits'));
  assert.equal(await activeAccount(page, true), undefined, 'credits and account URL must never stand in for identity');
  await page.setContent(fixture('person@example.test').replace('<p>person@example.test</p>', '<div class="ProseMirror">person@example.test</div>'));
  assert.equal(await activeAccount(page, true), undefined, 'a broad container that also includes the composer is not account evidence');

  await page.goto('https://accounts.google.com/');
  await page.setContent('<button aria-label="Google Account: Stale (old@example.test)">Stale badge</button>');
  assert.equal(await activeAccount(page, true), undefined, 'a sign-in page must not reuse a stale account badge');
  await assert.rejects(ensureJobProject(page, { params: { type: 'video' } }), /Sign in to Google/);
  console.log('Account identity: current labels, panel fallback, passive health, ambiguity, panel cleanup and signed-out guards passed. No generation submitted.');
} finally { await browser.close(); rmSync(scratch, { recursive: true, force: true }); }
