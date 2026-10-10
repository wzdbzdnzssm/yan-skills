import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

test('Kie CLI: real local media, budget and safe recovery',async(t)=>{
 const scripts=fileURLToPath(new URL('../scripts/',import.meta.url));
 const root=process.env.KIE_TEST_OUT||await mkdtemp(path.join(tmpdir(),'kie-cli-'));
 await mkdir(root,{recursive:true});
 const media=path.join(root,'fixture.mp4'),image=path.join(root,'input.png'),prompt=path.join(root,'prompt.txt'),params=path.join(root,'params.json');
 const mediaResult=spawnSync('ffmpeg',['-v','error','-y','-f','lavfi','-i','color=c=orange:s=320x180:d=2','-c:v','libx264','-pix_fmt','yuv420p',media]);assert.equal(mediaResult.status,0,mediaResult.stderr?.toString());
 const imageResult=spawnSync('ffmpeg',['-v','error','-y','-i',media,'-frames:v','1',image]);assert.equal(imageResult.status,0,imageResult.stderr?.toString());
 await writeFile(prompt,'Local fixture validation; not an AI-generated sample.');await writeFile(params,'{"duration":2}');
 const server=spawn(process.execPath,[path.join(scripts,'kie-fake-server.mjs'),'--media-file',media],{stdio:['ignore','pipe','pipe']});
 const origin=await new Promise((resolve,reject)=>{let data='';server.stdout.on('data',chunk=>{data+=chunk;if(data.includes('\n'))resolve(JSON.parse(data.split('\n')[0]).origin)});server.on('error',reject);server.on('exit',code=>reject(Error('fake server exit '+code)))});
 const control=async(value)=>assert.equal((await fetch(origin+'/__control',{method:'POST',body:JSON.stringify(value)})).status,200);
 const stats=async()=> (await fetch(origin+'/__stats')).json();
 const run=(name,extra=[],resume=false)=>spawnSync(process.execPath,[path.join(scripts,'kie-generate.mjs'),...(resume?['--resume']:['--model','local-fixture','--prompt-file',prompt,'--params-file',params,'--image',image,'--image-field','reference_image_urls','--expected-credits','82','--budget-credits','100']),'--out',path.join(root,name),'--base-url',origin,'--upload-base-url',origin,'--poll-ms','10','--timeout-ms','1000',...extra],{env:{...process.env,KIE_API_KEY:'local-fixture'},encoding:'utf8'});
 const result=async(name)=>JSON.parse(await readFile(path.join(root,name,'results.json'),'utf8'));
 try {
  await t.test('dry-run requests nothing',async()=>{assert.equal(run('dry').status,0);assert.equal((await stats()).counts.create,0);assert.equal((await stats()).counts.balance,0)});
  await t.test('insufficient budget and balance prevent create',async()=>{assert.equal(run('budget',['--budget-credits','10','--yes-spend']).status,1);await control({balance:40});assert.equal(run('balance',['--yes-spend']).status,1);assert.equal((await stats()).counts.create,0);await control({balance:1000})});
  await t.test('real curl to MP4/probe/six frames and correct cost',async()=>{assert.equal(run('completed',['--yes-spend']).status,0);const r=await result('completed');assert.equal(r.status,'completed');assert.equal(r.actualCredits,82);assert.equal(r.balanceDelta,82);assert.equal(r.unattributedCredits,0);assert.equal((await readdir(path.join(root,'completed'))).filter(n=>n.endsWith('.jpg')).length,6);assert.ok(r.uploads[0].uploadPath.endsWith(r.jobId));assert.equal(r.uploads[0].fileName,'0-input.png')});
  await t.test('existing receipt cannot be overwritten or recreated',async()=>{const before=await readFile(path.join(root,'completed','results.json'),'utf8'),n=(await stats()).counts.create;assert.equal(run('completed',['--yes-spend']).status,1);assert.equal(await readFile(path.join(root,'completed','results.json'),'utf8'),before);assert.equal((await stats()).counts.create,n)});
  await t.test('uncertain submission preserved without recreate',async()=>{await control({omitTaskId:true});assert.equal(run('uncertain',['--yes-spend']).status,1);assert.equal((await result('uncertain')).status,'submitting');const n=(await stats()).counts.create;assert.equal(run('uncertain',['--yes-spend']).status,1);assert.equal(run('uncertain',['--yes-spend'],true).status,1);assert.equal((await stats()).counts.create,n);await control({omitTaskId:false})});
  await t.test('poll timeout resumes same task without create',async()=>{await control({states:['waiting','success']});assert.equal(run('timeout',['--yes-spend','--timeout-ms','1']).status,1);const n=(await stats()).counts.create;assert.equal(run('timeout',['--yes-spend']).status,1);assert.equal(run('timeout',['--yes-spend'],true).status,0);assert.equal((await result('timeout')).error,undefined);assert.equal((await stats()).counts.create,n)});
  await t.test('download failure resumes only query/download',async()=>{await control({states:['success'],downloadStatus:404});assert.equal(run('download',['--yes-spend']).status,1);const n=(await stats()).counts.create;assert.equal((await result('download')).status,'success');await control({downloadStatus:200});assert.equal(run('download',['--yes-spend'],true).status,0);assert.equal((await result('download')).error,undefined);assert.equal((await stats()).counts.create,n)});
  await t.test('explicit provider failure does not recreate',async()=>{await control({states:['fail']});assert.equal(run('failed',['--yes-spend']).status,1);assert.equal((await result('failed')).status,'fail');const n=(await stats()).counts.create;assert.equal(run('failed',['--yes-spend']).status,1);assert.equal((await stats()).counts.create,n)});
  await t.test('same filename reference images receive isolated names and job paths',async()=>{await control({states:['success'],balance:1000});const second=path.join(root,'second');await mkdir(second,{recursive:true});await writeFile(path.join(second,'input.png'),await readFile(image));assert.equal(run('isolated',['--yes-spend','--image',path.join(second,'input.png')]).status,0);const r=await result('isolated');assert.notEqual(r.uploads[0].fileName,r.uploads[1].fileName);assert.notEqual(r.uploads[0].uploadPath,(await result('completed')).uploads[0].uploadPath);assert.deepEqual((await stats()).uploads.slice(-2).map(u=>u.fileName),['0-input.png','1-input.png'])});
  await writeFile(path.join(root,'cli-stats.json'),JSON.stringify(await stats(),null,2));
 }finally{server.kill();await new Promise(resolve=>server.once('exit',resolve));if(!process.env.KIE_TEST_OUT)await rm(root,{recursive:true,force:true})}
});
