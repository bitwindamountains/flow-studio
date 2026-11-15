import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type { SceneParams } from "./queue.js";

export class ReferenceUploadCache {
  private entries=new Map<string,Promise<string>>();
  async get(scope:string,file:string,upload:(digest:string,contents:Buffer)=>Promise<string>):Promise<string> {
    const contents=readFileSync(file);
    const hash=createHash("sha256").update(contents).digest("hex");
    const key=scope+"|"+hash;
    let entry=this.entries.get(key);
    if(!entry){
      if(this.entries.size>=256)this.entries.delete(this.entries.keys().next().value!);
      entry=Promise.resolve().then(()=>upload(hash,contents));this.entries.set(key,entry);
    }
    try{return await entry;}catch(error){if(this.entries.get(key)===entry)this.entries.delete(key);throw error;}
  }
  clear():void{this.entries.clear();}
}

export async function resetReferenceComposer(io:{clear:()=>Promise<void>;count:()=>Promise<number>;reload:()=>Promise<void>}):Promise<boolean>{
  await io.clear();let reloaded=false;
  if(await io.count()){await io.reload();reloaded=true;await io.clear();}
  if(await io.count())throw new Error("Flow still has old reference ingredients attached. Clear them in Flow before retrying; nothing was generated.");
  return reloaded;
}
export function assertReferenceCount(actual:number,expected:number):void{
  if(actual!==expected)throw new Error(`Flow must have exactly ${expected} selected reference image(s), but has ${actual}. Nothing was generated.`);
}

export function agentReferenceFiles(params:Pick<SceneParams,"agent_refs"|"agent_ref_assets"|"agent_scene_refs">,index:number):string[]|undefined{
  const uses=params.agent_scene_refs?.[index];
  const picked=(params.agent_refs??[]).map((reference,key)=>({reference,key})).filter(({reference})=>!uses||uses.some(name=>name.toLowerCase()===reference.name.toLowerCase()));
  return picked.length?picked.map(({reference,key})=>params.agent_ref_assets?.[key]?`asset:${params.agent_ref_assets[key]}`:reference.image):undefined;
}
