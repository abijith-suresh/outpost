import { strict as assert } from "node:assert";
import { execFileSync, spawn } from "node:child_process";
import { closeSync, existsSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// Delay only the actual old executable's completed config read, after its mutation lock.
// The installed old package and its decoder/writer remain unchanged.
export function verifyOldCachedWriter({ preceding, root, home, repoId, runInstalled }) {
  const bootstrap = join(root, "old-reader-bootstrap.mjs");
  const ready = join(root, "old-config-cached");
  const release = join(root, "release-old");
  const done = join(root, "old-done");
  const stdout = join(root, "old-writer.stdout");
  const stderr = join(root, "old-writer.stderr");
  writeFileSync(
    bootstrap,
    `import fs from 'node:fs';import {syncBuiltinESMExports} from 'node:module';import {pathToFileURL} from 'node:url';\nconst [binary,home,ready,release,done,...args]=process.argv.slice(2);const original=fs.readFile;let paused=false;fs.readFile=function(file,options,callback){return original.call(this,file,options,(error,data)=>{if(!paused&&String(file).split(String.fromCharCode(92)).join('/')===home+'/config.json'&&!error){paused=true;fs.writeFileSync(ready,JSON.stringify({cachedConfig:true,lockHeld:fs.existsSync(home+'/.mutation.lock')}));const start=Date.now();const resume=()=>{if(fs.existsSync(release))callback(error,data);else if(Date.now()-start>30000)callback(new Error('Fixture release deadline'));else setTimeout(resume,10);};resume();}else callback(error,data);});};syncBuiltinESMExports();process.on('exit',code=>fs.writeFileSync(done,String(code)));process.argv=[process.execPath,binary,...args];await import(pathToFileURL(binary).href);\n`
  );
  const descriptors = [openSync(stdout, "w"), openSync(stderr, "w")];
  const old = spawn(
    process.execPath,
    [
      bootstrap,
      preceding,
      home.replaceAll("\\", "/"),
      ready,
      release,
      done,
      "create",
      "--ticket",
      "OLDCACHED",
      "--type",
      "feat",
      "--repo",
      repoId,
      "--base-source",
      "local",
      "--base",
      "refs/heads/main",
      "--json",
    ],
    { env: { ...process.env, OUTPOST_HOME: home }, stdio: ["ignore", ...descriptors] }
  );
  descriptors.forEach(closeSync);
  const wait = (file) =>
    execFileSync(
      process.execPath,
      [
        "-e",
        `const fs=require('node:fs');const start=Date.now();while(!fs.existsSync(process.argv[1])){if(Date.now()-start>30000)throw Error('Fixture deadline');Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,10);}`,
        file,
      ],
      { stdio: "pipe", timeout: 31_000 }
    );
  try {
    wait(ready);
    assert.deepEqual(JSON.parse(readFileSync(ready, "utf8")), {
      cachedConfig: true,
      lockHeld: true,
    });
    const blocked = runInstalled(
      [
        "create",
        "--ticket",
        "NEWWHILEOLD",
        "--type",
        "feat",
        "--repo",
        repoId,
        "--base-source",
        "fresh-remote",
        "--remote",
        "team",
        "--base",
        "main",
        "--json",
      ],
      { OUTPOST_HOME: home }
    );
    assert.equal(blocked.status, 1);
    assert.equal(JSON.parse(blocked.stderr || blocked.stdout).error.reason, "lock-held");
    writeFileSync(release, "release");
    wait(done);
    assert.equal(
      readFileSync(done, "utf8"),
      "0",
      `${readFileSync(stdout)}\n${readFileSync(stderr)}`
    );
    assert.equal(
      JSON.parse(readFileSync(join(home, "workspaces", "OLDCACHED.json"), "utf8")).version,
      5
    );
    assert.equal(existsSync(join(home, "workspaces", "NEWWHILEOLD.json")), false);
    console.log(
      "Actual installed PR157 cached-config interleave: old writer held home lock; fresh invocation refused before effects, old v5 admission preserved v7/retained inventory."
    );
  } finally {
    writeFileSync(release, "release");
    if (!existsSync(done)) old.kill();
  }
}
