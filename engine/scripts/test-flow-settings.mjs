import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright-core';

// Isolated HTML fixture: never connects to Flow or uses its browser profile.
process.env.FLOW_MCP_HOME = mkdtempSync(join(tmpdir(), 'flow-settings-'));
const { applySettings } = await import('../dist/flow.js');
const { chromeExecutable } = await import('../dist/chrome.js');
const browser = await chromium.launch({
  executablePath: process.env.FLOW_TEST_CHROME ?? chromeExecutable(),
  headless: true,
});

function fixture({ model = 'Nano Banana 2.1', delay = 0 } = {}) {
  return `<!doctype html><style>
    [hidden] { display:none !important }
    #settings { position:relative; z-index:2; height:180px; overflow:auto; width:340px; background:white }
    .cdk-overlay-backdrop { position:fixed; inset:0; z-index:1 }
  </style>
  <button aria-label="Settings trigger" onclick="openSettings()">Settings</button>
  <div id="backdrop" hidden class="cdk-overlay-backdrop cdk-overlay-backdrop-showing"
    onclick="settings.hidden=true;this.hidden=true"></div>
  <div id="settings" hidden>
    <label><input type="radio" name="mode" checked>Image</label>
    <label><input type="radio" name="mode">Video</label>
    <label><input type="radio" name="aspect" checked>16:9</label>
    <button aria-label="Select model family" onclick="menu.hidden=false">${model}</button>
    <div id="menu" role="menu" hidden>
      <button role="menuitem" onclick="selectModel(this)">Nano Banana Pro</button>
      <button role="menuitem" onclick="selectModel(this)">Nano Banana 2.1</button>
    </div>
    <div role="radiogroup" aria-label="Thinking level" style="height:160px">
      <label><input type="radio" name="thinking">Low</label>
      <label><input type="radio" name="thinking">Medium</label>
      <label><input type="radio" name="thinking" checked>High</label>
    </div>
    <div id="outputs" role="radiogroup" aria-label="Outputs per prompt">
      <label><input type="radio" name="outputs">x1</label>
      <label><input type="radio" name="outputs" checked>x2</label>
    </div>
    <a href="#credits">0 credits</a>
  </div>
  <script>
    window.opens=0;
    function openSettings() {
      window.opens++; settings.hidden=false; backdrop.hidden=false;
      outputs.hidden=${delay > 0};
      ${delay > 0 ? `setTimeout(()=>outputs.hidden=false,${delay});` : ''}
    }
    function selectModel(item) {
      document.querySelector('[aria-label="Select model family"]').textContent=item.textContent;
      menu.hidden=true; settings.hidden=true; backdrop.hidden=true;
    }
    document.addEventListener('keydown', event => {
      if(event.key==='Escape') {
        if(!menu.hidden) menu.hidden=true;
        else {settings.hidden=true;backdrop.hidden=true}
      }
    });
  </script>`;
}

try {
  for (const [name, options, model] of [
    ['already-selected latest model closes settings while dismissing its menu', {}, undefined],
    ['changing model closes settings and reveals outputs after thinking controls', { model:'Nano Banana Pro', delay:250 }, undefined],
    ['named model retains its thinking level and selects one output below it', {}, 'Nano Banana 2.1'],
  ]) {
    const page = await browser.newPage();
    await page.setContent(fixture(options));
    const cost = await applySettings(page, { params: { type:'image', aspect_ratio:'16:9', model, variants:1 } });
    assert.equal(cost, 0);
    assert.equal(await page.locator('input[name="outputs"]').first().isChecked(), true);
    assert.equal(await page.locator('input[name="thinking"]').last().isChecked(), true, 'thinking stays High');
    assert.equal(await page.locator('#settings').isVisible(), false, 'settings dismissed when done');
    console.log(`PASS: ${name}`);
    await page.close();
  }
} finally {
  await browser.close();
}
