#!/usr/bin/env node
// 可复制 Miniflare 脚手架；仅本地 HTTP、临时目录、D1/R2，永不读真 key。验证：2026-10-04。
import { createRequire } from 'node:module';
import { readFile,writeFile,mkdtemp,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
import assert from 'node:assert/strict';
import { args } from '../../scripts/kie-lib.mjs';
const o=args(process.argv.slice(2));
if(o.help) {console.log('node templates/kie/local-verify.mjs --deps-project DIR --out JSON [--compatibility-date YYYY-MM-DD] [--dry-run]');process.exit(0)}
if(o['dry-run']) {console.log('dry-run，本地验证未运行');process.exit(0)}
if(!o['deps-project']||!o.out)throw Error('缺 --deps-project / --out');
const root=path.dirname(fileURLToPath(import.meta.url)),temp=await mkdtemp(path.join(tmpdir(),'kie-local-'));
const req=createRequire(path.resolve(o['deps-project'],'package.json')),wr=createRequire(req.resolve('wrangler/package.json'));
const {Miniflare,convertV4MiniflareOptions}=wr('miniflare'),{build}=wr('esbuild');
let created=0,mailed=0,balance=1000,downloadFailures=0,notificationFailures=0,downloads=0,db;
const records=new Map();
const server=createServer(async(req,res)=>{const u=new URL(req.url,'http://localhost');res.setHeader('Content-Type','application/json');
 if(u.pathname==='/api/v1/chat/credit')return res.end(JSON.stringify({code:200,data:balance}));
 if(u.pathname==='/api/v1/jobs/createTask'){created++;return res.end(JSON.stringify({code:200,data:{taskId:'fake'}}))}
 if(u.pathname==='/api/v1/jobs/recordInfo'){const id=u.searchParams.get('taskId');if(id==='stale')await db.prepare("UPDATE kie_jobs SET lease_until=lease_until+1 WHERE id='stale'").run();return res.end(JSON.stringify({code:200,data:{state:records.get(id)||'success',creditsConsumed:82,resultJson:{resultUrls:[origin+'/media']}}}))}
 if(u.pathname==='/media'){downloads++;if(downloadFailures-->0){res.writeHead(503);return res.end('unavailable')}res.setHeader('Content-Type','video/mp4');return res.end('local-fixture')}
 if(u.pathname==='/mail'){mailed++;if(notificationFailures-->0){res.writeHead(503);return res.end('{}')}return res.end('{}')}
 res.writeHead(404);res.end('{}');});
await new Promise(r=>server.listen(0,'127.0.0.1',r));const origin=`http://127.0.0.1:${server.address().port}`;
let mf;
try {
 const bundled=await build({stdin:{contents:`import {reserve,refund} from './budget';import {monitor} from './ops';import {KieClient,verifyWebhook} from './kie-client';import {settle,cron} from './lifecycle';
 export default {async fetch(request,env){const url=new URL(request.url);const kie=new KieClient('local-fixture',env.ORIGIN);
 if(url.pathname==='/reserve'){const ok=await reserve(env.DB,{id:url.searchParams.get('id'),userId:'u',siteCredits:10,micros:410000,dailyLimit:Number(url.searchParams.get('daily')||1000000),totalLimit:Number(url.searchParams.get('total')||410000),day:'2026-10-04',sourceExpiresAt:Date.now()+3600000});if(ok)await kie.create('fake',{});return Response.json({ok})}
 if(url.pathname==='/refund'){await refund(env.DB,'one');await refund(env.DB,'one');return Response.json({ok:true})}
 if(url.pathname==='/monitor'){await monitor(env.DB,kie,{warn:1000,pause:164,resume:1000,totalLimit:410000},async(message,key)=>{await fetch(env.ORIGIN+'/mail',{method:'POST',body:JSON.stringify({message,key})})});return Response.json({ok:true})}
 if(url.pathname==='/hmac'){return Response.json({taskId:await verifyWebhook(request,'local-hmac')})}
 if(url.pathname==='/prepare'){const id=url.searchParams.get('id');await env.PHOTOS.put('photo/'+id,'source');await env.DB.prepare("INSERT INTO kie_jobs(id,user_id,task_id,status,site_credits,budget_micros,day,photo_keys,source_expires_at) VALUES(?,'u',?,'pending',10,410000,'2026-10-04',?,?)").bind(id,id,JSON.stringify(['photo/'+id]),Date.now()+3600000).run();return Response.json({ok:true})}
 if(url.pathname==='/settle'){const id=url.searchParams.get('id'),clock=Date.now;try{const client=id.startsWith('expired-')?{record:async(task)=>{const record=await kie.record(task);Date.now=()=>clock()+180001;return record}}:kie;await settle(env,client,id);return Response.json({ok:true})}catch{return Response.json({ok:false})}finally{Date.now=clock}}
 if(url.pathname==='/cron'){await cron(env,kie,async(id,key)=>{const response=await fetch(env.ORIGIN+'/mail',{method:'POST',body:JSON.stringify({id,key})});if(!response.ok)throw Error('mail failed')});return Response.json({ok:true})}
 await env.OUTPUTS.put('fixture','local-result');return new Response(await env.OUTPUTS.get('fixture').then(o=>o.text()))}}`,resolveDir:root,loader:'ts'},bundle:true,write:false,format:'esm',platform:'browser'});
 const options={modules:true,script:bundled.outputFiles[0].text,cf:false,compatibilityDate:o['compatibility-date']||'2026-09-01',d1Databases:['DB'],r2Buckets:['OUTPUTS','PHOTOS'],d1Persist:path.join(temp,'d1'),r2Persist:path.join(temp,'r2'),bindings:{ORIGIN:origin}};
 mf=new Miniflare(convertV4MiniflareOptions?convertV4MiniflareOptions(options):options);
 db=await mf.getD1Database('DB');
 // D1 exec 对触发器内的分号不能逐行拆；逐 SQL 语句经 prepare 执行。
 const sql=await readFile(path.join(root,'migration.sql'),'utf8');
 const statements=sql.replace(/^--.*$/mg,'').match(/\s*CREATE TRIGGER[\s\S]*?END;|[^;]+;/g);
 for(const statement of statements)await db.prepare(statement).run();
 await db.prepare("INSERT INTO kie_users(id,credits) VALUES('u',100)").run();
 const call=async(route)=> (await mf.dispatchFetch('http://local'+route)).json();
 const concurrent=await Promise.all([call('/reserve?id=one'),call('/reserve?id=one')]);assert.equal(concurrent.filter(r=>r.ok).length,1);assert.equal((await call('/reserve?id=two')).ok,false);assert.equal((await call('/reserve?id=three&daily=410000&total=1000000')).ok,false);assert.equal(created,1);
 await call('/refund');assert.equal((await db.prepare("SELECT credits FROM kie_users WHERE id='u'").first()).credits,100);
 assert.equal((await db.prepare("SELECT reserved_micros FROM kie_ops WHERE id=1").first()).reserved_micros,410000);
 balance=40;await call('/monitor');await call('/monitor');assert.equal(mailed,1);assert.equal((await db.prepare('SELECT paused FROM kie_ops').first()).paused,1);
 balance=500;await call('/monitor');assert.equal((await db.prepare('SELECT paused FROM kie_ops').first()).paused,1);
 balance=1000;await call('/monitor');assert.equal((await db.prepare('SELECT paused FROM kie_ops').first()).paused,0);
 const timestamp=String(Math.floor(Date.now()/1000));const {createHmac}=await import('node:crypto');const signature=createHmac('sha256','local-hmac').update('fake.'+timestamp).digest('base64');
 const h=await mf.dispatchFetch('http://local/hmac',{method:'POST',headers:{'X-Webhook-Timestamp':timestamp,'X-Webhook-Signature':signature},body:JSON.stringify({data:{taskId:'fake'}})});assert.equal((await h.json()).taskId,'fake');
 assert.equal(await (await mf.dispatchFetch('http://local/r2')).text(),'local-result');
 const bad=await mf.dispatchFetch('http://local/hmac',{method:'POST',headers:{'X-Webhook-Timestamp':timestamp,'X-Webhook-Signature':'AAAA'},body:JSON.stringify({data:{taskId:'fake'}})});assert.equal(bad.status,500);
 const old=String(Number(timestamp)-301),oldSignature=createHmac('sha256','local-hmac').update('fake.'+old).digest('base64');
 const replay=await mf.dispatchFetch('http://local/hmac',{method:'POST',headers:{'X-Webhook-Timestamp':old,'X-Webhook-Signature':oldSignature},body:JSON.stringify({data:{taskId:'fake'}})});assert.equal(replay.status,500);
 const photos=await mf.getR2Bucket('PHOTOS'),outputs=await mf.getR2Bucket('OUTPUTS');
 const job=async(id)=>db.prepare('SELECT * FROM kie_jobs WHERE id=?').bind(id).first();
 await call('/prepare?id=success');await Promise.all([call('/settle?id=success'),call('/settle?id=success')]);assert.equal(downloads,1);assert.equal((await job('success')).status,'completed');assert.equal((await job('success')).cost_credits,82);assert.equal(await photos.get('photo/success'),null);assert.equal(await (await outputs.get('output/success/0')).text(),'local-fixture');
 await call('/prepare?id=failed');records.set('failed','fail');const credits=(await db.prepare("SELECT credits FROM kie_users WHERE id='u'").first()).credits;await call('/settle?id=failed');await call('/settle?id=failed');assert.equal((await job('failed')).status,'failed');assert.equal((await db.prepare("SELECT credits FROM kie_users WHERE id='u'").first()).credits,credits+10);assert.equal(await photos.get('photo/failed'),null);
 await call('/prepare?id=retry');downloadFailures=1;assert.equal((await call('/settle?id=retry')).ok,false);assert.equal((await job('retry')).status,'pending');assert.ok(await photos.get('photo/retry'));await call('/settle?id=retry');assert.equal((await job('retry')).status,'completed');assert.equal(created,1);
 await call('/prepare?id=stale');await call('/settle?id=stale');assert.equal((await job('stale')).status,'pending');assert.ok(await photos.get('photo/stale'));records.set('stale','fail');await db.prepare("UPDATE kie_jobs SET lease_until=0 WHERE id='stale'").run();await call('/settle?id=stale');assert.equal((await job('stale')).status,'pending');assert.equal((await db.prepare("SELECT count(*) AS n FROM kie_ledger WHERE ref='refund:stale'").first()).n,0);
 for(const state of ['success','fail']){const id='expired-'+state;await call('/prepare?id='+id);records.set(id,state);await call('/settle?id='+id);assert.equal((await job(id)).status,'pending');assert.equal((await job(id)).lease_until,0);assert.ok(await photos.get('photo/'+id));assert.equal((await db.prepare('SELECT count(*) AS n FROM kie_ledger WHERE ref=?').bind('refund:'+id).first()).n,0);records.set(id,'waiting')}
 await db.prepare("UPDATE kie_jobs SET lease_until=0 WHERE id='stale'").run();records.set('stale','waiting');await db.prepare("UPDATE kie_jobs SET source_expires_at=0 WHERE id='stale'").run();notificationFailures=1;await call('/cron');assert.equal((await job('one')).notified_at,null);await call('/cron');assert.ok((await job('one')).notified_at);assert.equal(await photos.get('photo/stale'),null);
 const evidence={passed:true,created,mailed,downloads,checks:['atomic daily/total reservation','idempotent submit','refund once','budget retained','pause/hysteresis/recovery','mail dedup','HMAC wire format','signature/replay rejection','R2 roundtrip','success/download/cost/source deletion','failure refund once','download recovery without create','concurrent lease','stale lease cannot complete/refund/delete','expired same-token success cannot complete/delete','expired same-token failure cannot refund/delete','notification retry','expired source deletion'],realProviderCalls:0};
 await writeFile(o.out,JSON.stringify(evidence,null,2));console.log(JSON.stringify(evidence));
}finally{if(mf)await mf.dispose();await new Promise(r=>server.close(r));await rm(temp,{recursive:true,force:true})}
