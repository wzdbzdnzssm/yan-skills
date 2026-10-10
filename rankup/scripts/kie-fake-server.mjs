#!/usr/bin/env node
// 本地假 Kie + 邮件；余额、状态序列、扣费可控；只绑定 loopback。验证：2026-10-04。
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { args, number, fail } from './kie-lib.mjs';
try {
 const o=args(process.argv.slice(2));
 if(o.help) console.log('node scripts/kie-fake-server.mjs [--port N] [--balance N] [--cost N] [--states waiting,generating,success] [--media-file MP4] [--dry-run]\nGET /__stats 计数；POST /__control {balance,states,cost}；POST /mail 假通知。不需要 key。');
 else if(o['dry-run']) console.log('dry-run，不启动服务');
 else {
  let balance=number(o.balance??1000,'balance'),cost=number(o.cost??82,'cost'),states=(o.states||'waiting,generating,success').split(',');
  const counts={balance:0,upload:0,create:0,poll:0,download:0,mail:0}, tasks=new Map(),uploads=[];
  let omitTaskId=false,downloadStatus=200;
  const media=o['media-file']?await readFile(o['media-file']):Buffer.from('fake media: provide --media-file for ffprobe');
  const server=createServer(async(req,res)=>{
   const url=new URL(req.url,'http://127.0.0.1');let body='';for await(const chunk of req) body+=chunk;
   const origin=`http://127.0.0.1:${server.address().port}`;
   const send=(data,code=200)=>{res.writeHead(code,{'content-type':'application/json'});res.end(JSON.stringify(data));};
   if(url.pathname==='/__stats') return send({counts,balance,tasks:tasks.size,uploads});
   if(url.pathname==='/__control'&&req.method==='POST') {try {const p=JSON.parse(body);if(p.balance!==undefined) balance=number(p.balance,'balance');if(p.cost!==undefined)cost=number(p.cost,'cost');if(p.states)states=p.states;if(p.omitTaskId!==undefined)omitTaskId=p.omitTaskId;if(p.downloadStatus!==undefined)downloadStatus=number(p.downloadStatus,'downloadStatus');return send({ok:true});}catch{return send({ok:false},400);}}
   if(url.pathname==='/api/v1/chat/credit') {counts.balance++;return send({code:200,data:balance});}
   if(url.pathname==='/api/file-stream-upload') {counts.upload++;const uploadPath=body.match(/name="uploadPath"\r\n\r\n([^\r\n]+)/)?.[1],fileName=body.match(/name="fileName"\r\n\r\n([^\r\n]+)/)?.[1];uploads.push({uploadPath,fileName});return send({code:200,data:{downloadUrl:origin+'/input.png'}});}
   if(url.pathname==='/api/v1/jobs/createTask') {counts.create++;if(balance<cost)return send({code:402});const id='fake-'+counts.create;tasks.set(id,{index:0,states:[...states],cost});balance-=cost;return send({code:200,data:omitTaskId?{}:{taskId:id}});}
   if(url.pathname==='/api/v1/jobs/recordInfo') {counts.poll++;const id=url.searchParams.get('taskId'),t=tasks.get(id);if(!t)return send({code:422});const state=t.states[Math.min(t.index++,t.states.length-1)];return send({code:200,data:{taskId:id,state,creditsConsumed:t.cost,failCode:state==='fail'?'MOCK_FAILURE':null,resultJson:JSON.stringify({resultUrls:[origin+'/output.mp4']})}});}
   if(url.pathname==='/output.mp4') {counts.download++;res.writeHead(downloadStatus,{'content-type':'video/mp4'});return res.end(media);}
   if(url.pathname==='/mail') {counts.mail++;return send({ok:true});}
   send({code:404},404);
  });
  server.listen(number(o.port??0,'port'),'127.0.0.1',()=>console.log(JSON.stringify({origin:`http://127.0.0.1:${server.address().port}`})));
  for(const signal of ['SIGINT','SIGTERM']) process.on(signal,()=>server.close());
 }
} catch(e) {fail(e);}
