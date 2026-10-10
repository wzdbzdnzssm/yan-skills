import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {nodeCli} from '../scripts/lib-node-cli.mjs';
import {probeBrowserBridge} from '../../rankup/scripts/demand/_lib.mjs';

test('Windows npm entry in a spaced path preserves JSON and shell metacharacters', () => {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'node cli fixture '));
  try {
    const pkg=path.join(root,'node_modules/@jackwener/opencli');
    fs.mkdirSync(pkg,{recursive:true});
    fs.writeFileSync(path.join(root,'opencli.cmd'),'@echo off\n');
    fs.writeFileSync(path.join(pkg,'package.json'),JSON.stringify({bin:{opencli:'cli.mjs'}}));
    fs.writeFileSync(path.join(pkg,'cli.mjs'),'console.log(JSON.stringify(process.argv.slice(2)))');
    const args=['space value',JSON.stringify({quote:'"',url:'https://example.test/?a=1&b=2'}),'& echo injected','%PATH%','$(echo injected)','a; b'];
    const resolved=nodeCli('opencli',args,{platform:'win32',env:{Path:root}});
    const result=spawnSync(resolved.command,resolved.args,{encoding:'utf8'});
    assert.equal(result.status,0);assert.deepEqual(JSON.parse(result.stdout),args);
    assert.equal(resolved.command,process.execPath);
    fs.writeFileSync(path.join(pkg,'package.json'),JSON.stringify({bin:{opencli:'../../../../outside.mjs'}}));
    assert.throws(()=>nodeCli('opencli',args,{platform:'win32',env:{PATH:root}}),/outside/);
  } finally { fs.rmSync(root,{recursive:true,force:true}); }
});
test('Unix and other binaries retain their original arguments',()=>{
  const args=['x']; assert.deepEqual(nodeCli('opencli',args,{platform:'linux'}),{command:'opencli',args});
  assert.deepEqual(nodeCli('node',args,{platform:'win32'}),{command:'node',args});
});
test('Missing Windows installation fails explicitly',()=>{
  assert.throws(()=>nodeCli('opencli',[],{platform:'win32',env:{PATH:''}}),/not found/);
});
test('Missing browser executable retains the indeterminate probe result',()=>{
  assert.equal(probeBrowserBridge('definitely-missing-cli-fixture'),null);
});
test('Failed social CLI is recorded as unknown count and does not abort radar', {skip:process.platform !== 'win32'},()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'game failed source '));
  try {
    const env={...process.env};for(const key of Object.keys(env))if(key.toLowerCase()==='path')env[key]='';
    const script=fileURLToPath(new URL('../../game-opportunity/scripts/game-opportunity.mjs',import.meta.url));
    const result=spawnSync(process.execPath,[script,'radar','--source','reddit','--date','2099-01-02','--project-root',root],{encoding:'utf8',env});
    assert.equal(result.status,0,result.stderr);
    const report=JSON.parse(fs.readFileSync(path.join(root,'.rankup/demand/game-review/2099-01-02-radar.json'),'utf8'));
    assert.equal(report.sources.length,1);assert.equal(report.sources[0].status,'failed');assert.equal(report.sources[0].count,null);assert(report.sources[0].error.includes('not found'));assert.equal(report.candidates.length,0);
  } finally {fs.rmSync(root,{recursive:true,force:true});}
});
