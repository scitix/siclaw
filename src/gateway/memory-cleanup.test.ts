import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { LocalMemoryStore } from "../memory/local-store.js";
import { clearUserMemory } from "./memory-cleanup.js";
it("clears exactly one user generation while preserving legacy migration inputs",()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),"clear-memory-"));const stores:LocalMemoryStore[]=[];
 try{
  for(const user of ["alice","bob"])stores.push(new LocalMemoryStore(path.join(root,"memory-v2",createHash("sha256").update(user).digest("hex"))));
  fs.mkdirSync(path.join(root,"memory"));fs.writeFileSync(path.join(root,"memory","legacy.md"),"migration evidence");
  clearUserMemory("alice",root);
  for(const [i,user] of ["alice","bob"].entries()){
   const db=new DatabaseSync(path.join(root,"memory-v2",createHash("sha256").update(user).digest("hex"),"memory-v2.db"));
   try{expect(db.prepare("SELECT generation FROM state").get()!.generation).toBe(i===0?1:0);}finally{db.close();}
  }
  expect(fs.readFileSync(path.join(root,"memory","legacy.md"),"utf8")).toBe("migration evidence");
 }finally{stores.forEach(s=>s.close());fs.rmSync(root,{recursive:true,force:true});}
});
