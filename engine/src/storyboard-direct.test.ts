import assert from "node:assert/strict";
import { test } from "node:test";
import { JobQueue,type Job,type SceneParams } from "./queue.js";

const params=(scene:number):SceneParams=>({prompt:`exact still ${scene}`,type:"image",max_credits:0,output_dir:"unused",file_stem:`scene-${scene}`,reference_images:["chosen.png"],studio:{project:"P",sub:"ad",kind:"storyboard",scene}});
async function until(check:()=>boolean){for(let n=0;n<100&&!check();n++)await new Promise(r=>setTimeout(r,5));assert.ok(check(),"queue reached expected state");}

test("direct storyboard jobs preserve prompts/references and finish independently after a failure",async()=>{
  const requests:SceneParams[]=[],done:string[]=[],events:string[]=[];
  const queue=new JobQueue(async job=>{
    requests.push(structuredClone(job.params));events.push(`start-${job.params.studio!.scene}`);
    if(job.params.studio!.scene===2)throw new Error("one still failed");
    return[`${job.params.file_stem}.png`];
  },{pauseMs:[0,0],onDone:job=>{done.push(job.id);events.push(`done-${job.params.studio!.scene}`);}});
  queue.pause("assemble");const jobs=[1,2,3].map(n=>queue.add(params(n)));queue.resume();
  await until(()=>jobs.every(j=>j.status==="done"||j.status==="failed"));
  assert.deepEqual(requests,[1,2,3].map(params));
  assert.deepEqual(jobs.map(j=>j.status),["done","failed","done"]);
  assert.match(jobs[1].error!,/one still failed/);
  assert.deepEqual(done,[jobs[0].id,jobs[2].id]);
  assert.deepEqual(events,["start-1","done-1","start-2","start-3","done-3"]);
});

test("unsubmitted storyboard scenes stay cancellable and obey queue pause",async()=>{
  let release!:()=>void;
  const first=new Promise<void>(resolve=>{release=resolve;});
  const started:number[]=[];
  const queue=new JobQueue(async job=>{
    started.push(job.params.studio!.scene);
    if(job.params.studio!.scene===1)await first;
    return[`${job.params.file_stem}.png`];
  },{pauseMs:[0,0]});
  queue.pause("assemble");const [a,b,c]=[1,2,3].map(n=>queue.add(params(n)));queue.resume();
  await until(()=>started.length===1);
  assert.equal(a.status,"running");assert.equal(b.status,"queued");assert.equal(c.status,"queued");
  queue.cancel(b.id);queue.pause("owner paused");release();
  await until(()=>a.status==="done");
  assert.equal(b.status,"cancelled");assert.equal(c.status,"queued");assert.deepEqual(started,[1]);
  queue.resume();await until(()=>c.status==="done");assert.deepEqual(started,[1,3]);
});

test("image spacing is used between direct storyboard jobs",async()=>{
  const starts:number[]=[],finishes:number[]=[];
  const queue=new JobQueue(async()=>{starts.push(Date.now());return["still.png"];},{pauseMs:[0,0],imagePauseMs:[25,25],onDone:()=>{finishes.push(Date.now());}});
  queue.pause("assemble");const jobs:Job[]=[queue.add(params(1)),queue.add(params(2))];queue.resume();
  await until(()=>jobs.every(j=>j.status==="done"));
  assert.ok(starts[1]-finishes[0]>=20,"configured image gap occurs after the previous image finishes");
});
