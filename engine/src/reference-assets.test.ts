import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync,writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ReferenceUploadCache, resetReferenceComposer, assertReferenceCount, agentReferenceFiles } from "./reference-assets.js";

test("reference uploads reuse identical content only within the same account/project", async()=>{
  const dir=mkdtempSync(join(tmpdir(),"flow-ref-cache-")),a=join(dir,"one.png"),b=join(dir,"two.png");
  writeFileSync(a,"image");writeFileSync(b,"image");
  const cache=new ReferenceUploadCache();let uploads=0;const upload=async()=>`asset-${++uploads}`;
  assert.equal(await cache.get("account-a/project-1",a,upload),"asset-1");
  assert.equal(await cache.get("account-a/project-1",b,upload),"asset-1");
  await cache.get("account-b/project-1",a,upload);await cache.get("account-a/project-2",a,upload);
  writeFileSync(a,"changed image");await cache.get("account-a/project-1",a,upload);
  assert.equal(uploads,4);
});
test("failed uploads do not poison the cache",async()=>{
  const file=join(mkdtempSync(join(tmpdir(),"flow-ref-fail-")),"ref.png");writeFileSync(file,"x");
  const cache=new ReferenceUploadCache();await assert.rejects(cache.get("scope",file,async()=>{throw new Error("upload failed");}));
  assert.equal(await cache.get("scope",file,async()=>"good"),"good");
});
test("the upload receives the same content snapshot that was hashed",async()=>{
  const file=join(mkdtempSync(join(tmpdir(),"flow-ref-snapshot-")),"ref.png");writeFileSync(file,"original");
  const cache=new ReferenceUploadCache();
  const pending=cache.get("scope",file,async(digest,contents)=>{assert.equal(contents.toString(),"original");assert.equal(digest.length,64);return"original-asset";});
  writeFileSync(file,"replacement");await pending;
  assert.equal(await cache.get("scope",file,async()=>"replacement-asset"),"replacement-asset");
});
test("old ingredient chips are reset and exact selection is enforced even for no reference",async()=>{
  let chips=2,reloads=0;
  assert.equal(await resetReferenceComposer({clear:async()=>{},count:async()=>chips,reload:async()=>{reloads++;chips=0;}}),true);
  assert.equal(reloads,1);
  await assert.rejects(resetReferenceComposer({clear:async()=>{},count:async()=>1,reload:async()=>{}}),/old reference/);
  assert.throws(()=>assertReferenceCount(2,1),/exactly 1/);
  assert.throws(()=>assertReferenceCount(1,0),/exactly 0/);
  assertReferenceCount(0,0);
});
test("individual batch recovery never truncates the selected reference set",()=>{
  const refs=[1,2,3,4].map(n=>({image:`ref-${n}.png`,name:`product-${n}`}));
  const params={agent_refs:refs,agent_ref_assets:["one","two","three","four"],agent_scene_refs:[refs.map(r=>r.name),[]]};
  assert.deepEqual(agentReferenceFiles(params,0),["asset:one","asset:two","asset:three","asset:four"]);
  assert.equal(agentReferenceFiles(params,1),undefined);
});
