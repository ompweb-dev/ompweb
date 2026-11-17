import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { jitiPath, nodeBinary } from "./update-fixture.test-helper.mjs";

test("a separate reader cannot observe a partially written commit decision", { timeout: 30_000 }, (t) => {
  const root = mkdtempSync(join(tmpdir(), "host-decision-publication-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const agent = join(root, "agent"), updates = join(agent, "omp-web", "host-update");
  const id = "decision-publication", version = "0.8.0", attempt = join(updates, id);
  mkdirSync(attempt, { recursive: true, mode: 0o700 });
  const marker = join(attempt, "decision.json");
  writeFileSync(join(attempt, "descriptor.json"), JSON.stringify({ id, version, prepareOnly: true }), { mode: 0o600 });
  writeFileSync(join(updates, "status.json"), JSON.stringify({ startedAt: Date.now(), operation: { id, version, target: "ompweb", state: "running", prepared: true } }), { mode: 0o600 });
  const reader = `const fs=require("node:fs");const file=${JSON.stringify(marker)};if(!fs.existsSync(file))console.log("absent");else{try{JSON.parse(fs.readFileSync(file,"utf8"));console.log("complete");}catch{console.log("partial");}}`;
  const script = join(root, "publish.cjs");
  writeFileSync(script, `
const assert=require("node:assert/strict"),fs=require("node:fs"),{execFileSync}=require("node:child_process");
const marker=${JSON.stringify(marker)},write=fs.writeFileSync,observations=[];
fs.writeFileSync=function(path,data,options){
  if(String(path).startsWith(marker)){
    write(path,"",options);
    observations.push(execFileSync(process.execPath,["-e",${JSON.stringify(reader)}],{encoding:"utf8"}).trim());
    return write(path,data,{...options,flag:"w"});
  }
  return write(path,data,options);
};
require("node:module").syncBuiltinESMExports();
require(${JSON.stringify(jitiPath)}).createJiti(__filename).import(${JSON.stringify(fileURLToPath(new URL("./update-worker.ts", import.meta.url)))}).then(worker=>{
  worker.writeHostUpdateDecision(${JSON.stringify(id)},"commit");
  assert.deepEqual(observations,["absent"],"an independent reader must not see an incomplete decision");
  const expected={id:${JSON.stringify(id)},version:${JSON.stringify(version)},decision:"commit"};
  assert.deepEqual(JSON.parse(fs.readFileSync(marker,"utf8")),expected);
  assert.throws(()=>worker.writeHostUpdateDecision(${JSON.stringify(id)},"cancel"));
  assert.deepEqual(JSON.parse(fs.readFileSync(marker,"utf8")),expected,"a conflicting decision cannot overwrite the winner");
}).catch(error=>{console.error(error);process.exitCode=1;});
`);
  execFileSync(nodeBinary(), [script], { env: { ...process.env, PI_CODING_AGENT_DIR: agent }, encoding: "utf8", timeout: 25_000 });
});
