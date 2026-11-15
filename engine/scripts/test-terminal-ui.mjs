import assert from 'node:assert/strict';
import {readFileSync,mkdirSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {chromium} from 'playwright-core';
import {chromeExecutable} from '../dist/chrome.js';
import {deriveWorkflow} from '../dist/workflow.js';
import {isStill} from '../dist/projects.js';
const root=fileURLToPath(new URL('../../',import.meta.url));
mkdirSync(root+'.tmp',{recursive:true});
const browser=await chromium.launch({executablePath:process.env.FLOW_TEST_CHROME??chromeExecutable(),headless:true});
try {
 for (const width of [1366,480]) {
  const page=await browser.newPage({viewport:{width,height:800}});
  await page.route('**/*',r=>r.abort());
  const errors=[];page.on('pageerror',e=>errors.push(e.message));
  const html=readFileSync(root+'ui/index.html','utf8').replace(/<script[^>]*>[\s\S]*?<\/script>/g,'').replace(/<link[^>]*>/g,'').replace('__FLOW_TOKEN__','fixture').replace('__OWNER__','1');
  await page.setContent(html);
  await page.addStyleTag({content:readFileSync(root+'ui/studio.css','utf8')});
  await page.addScriptTag({content:'window.isStill = '+isStill.toString()+'; window.deriveWorkflow = '+deriveWorkflow.toString()});
  await page.addStyleTag({content:readFileSync(root+'engine/node_modules/@xterm/xterm/css/xterm.css','utf8')});
  for(const file of ['@xterm/xterm/lib/xterm.js','@xterm/addon-fit/lib/addon-fit.js'])await page.addScriptTag({content:readFileSync(root+'engine/node_modules/'+file,'utf8')});
  await page.evaluate(()=>{
   window.fixture={sent:[],agent:'claude',session:1,status:'running',exitCode:undefined};
   const f=window.fixture;
   f.state=()=>f.socket.onmessage({data:JSON.stringify({t:'agent',agent:f.agent,session:f.session,status:f.status,exitCode:f.exitCode})});
   window.WebSocket=class {
    readyState=0;
    constructor(){f.socket=this;setTimeout(()=>{this.readyState=1;this.onopen?.();f.state()},10)}
    send(raw){const m=JSON.parse(raw);f.sent.push(m);if(m.t==='agent'||m.t==='restart'){f.agent=m.agent??f.agent;f.session++;f.status='running';f.exitCode=undefined;f.state()}}
   };
   window.fetch=async(url)=>{const m=String(url).split('/').pop();const data=m==='studio_workflow_read'?window.deriveWorkflow({plan:{project:'Demo',sub:'ad',aspect:'9:16',scenes:[{n:1,prompt:'fixture',kept:true,clip:'fixture.mp4'}]},scenes:[{n:1,validPlan:true,validSource:true,storyboardExists:false,clipExists:true,hasTakes:false,hasActiveJob:false}],renderVersions:[],editTaskPhase:null}):m==='studio_projects'?[{project:'Demo',subs:['ad']}]:m==='studio_current'?{project:'Demo',sub:'ad'}:m==='studio_plan_read'?{project:'Demo',sub:'ad',aspect:'9:16',scenes:[{n:1,prompt:'fixture',kept:true,clip:'fixture.mp4'}]}:m==='studio_edit_notes_read'?{text:'fixture notes',rev:'1'}:m==='studio_renders'?{renders:[]}:m==='accounts'||m==='pending'?[]:{};return{json:async()=>data}};
  });
  await page.addScriptTag({content:readFileSync(root+'ui/app.js','utf8')});
  await page.waitForFunction(()=>document.querySelector('#agent-status').textContent.includes('running'));
  await page.locator('#chat-toggle').click();
  await page.locator('#chat-tab-terminal').click();
  const workspaceBox=await page.locator('#player').boundingBox(),terminalBox=await page.locator('#term-wrap').boundingBox();
  // Chat is a drawer beside the desk on wide screens and a bottom sheet on narrow ones.
  if(width>=1024) assert.ok(terminalBox.x>=workspaceBox.x+workspaceBox.width-1,'terminal must sit beside the workspace on wide screens');
  else assert.ok(Math.abs(terminalBox.y+terminalBox.height-800)<=2,'terminal must be a bottom sheet on narrow screens');
  if(width>=1024) assert.ok((await page.locator('#player').boundingBox()).height>=260,'the agent drawer must leave a useful working canvas on a laptop');
  assert.ok((await page.locator('#term').boundingBox()).height>=200,'the terminal tab has usable height');
  assert.equal(await page.getByRole('button',{name:'Expand terminal',exact:true}).count(),1);
  assert.equal(await page.getByRole('button',{name:'Switch agent',exact:true}).isDisabled(),true);
  await page.getByLabel('Terminal agent',{exact:true}).selectOption('codex');
  await page.getByRole('button',{name:'Switch agent',exact:true}).click();
  await page.waitForFunction(()=>document.querySelector('#agent-status').textContent==='Codex CLI · running');
  assert.equal(await page.evaluate(()=>document.activeElement.classList.contains('xterm-helper-textarea')),true);
  await page.evaluate(()=>window.fixture.socket.onmessage({data:JSON.stringify({t:'output',data:'{"t":"agent","agent":"claude","status":"exited","session":99}'})}));
  assert.equal(await page.getByLabel('Terminal agent',{exact:true}).inputValue(),'codex','terminal output cannot spoof control messages');
  await page.locator('#chat .drawer-close').click(); // a narrow sheet covers the strip bar
  await page.locator('#details-toggle').click();
  await page.waitForFunction(()=>document.querySelector('#details-video button.big')?.disabled===false);
  assert.ok(!(await page.locator('#details-video').innerText()).includes('null'), 'optional Edit elements must not render null text');
  await page.evaluate(()=>{window.fixture.status='exited';window.fixture.exitCode=1;window.fixture.state()});
  await page.waitForFunction(()=>document.querySelector('#details-video button.big')?.disabled===true);
  await page.locator('#details .drawer-close').click();
  await page.locator('#chat-toggle').click();
  assert.equal(await page.getByRole('status').filter({hasText:'Codex CLI · exited (1)'}).count(),1);
  await page.getByRole('button',{name:'Restart',exact:true}).click();
  await page.waitForFunction(()=>document.querySelector('#agent-status').textContent==='Codex CLI · running');
  await page.evaluate(()=>{
   const f=window.fixture;
   f.socket.onmessage({data:JSON.stringify({t:'output',data:'OLD_SESSION_OUTPUT\r\n'.repeat(20)})});
   f.session++;f.state();
   f.socket.onmessage({data:JSON.stringify({t:'output',data:'NEW_SESSION_READY\r\n'})});
  });
  await page.waitForFunction(()=>Array.from({length:term.buffer.active.length},(_,i)=>term.buffer.active.getLine(i)?.translateToString()).join('\n').includes('NEW_SESSION_READY'));
  const screen=await page.evaluate(()=>Array.from({length:term.buffer.active.length},(_,i)=>term.buffer.active.getLine(i)?.translateToString()).join('\n'));
  assert.ok(!screen.includes('OLD_SESSION_OUTPUT'),'queued output from the previous chat must not leak after reset');
  await page.getByRole('button',{name:'Expand terminal',exact:true}).click();
  assert.ok((await page.locator('#term').boundingBox()).height>500,'expanded terminal must have usable height');
  assert.equal(await page.locator('#player').isVisible(),false);
  await page.getByRole('button',{name:'Restore layout',exact:true}).click();
  assert.equal(await page.locator('#player').isVisible(),true);
  for(const id of ['agent','switch-agent','restart']){
   const box=await page.locator('#'+id).boundingBox();assert.ok(box&&box.x>=0&&box.x+box.width<=width+1,`${id} overflow at width ${width}`);
  }
  await page.screenshot({path:root+`.tmp/codex-terminal-${width}.png`});
  assert.deepEqual(errors,[]);
  console.log(`Browser ${width}px: switching, focus, output isolation, exit gating, restart, expansion, stale-output reset, and control bounds passed.`);
  await page.close();
 }
}finally{await browser.close()}
