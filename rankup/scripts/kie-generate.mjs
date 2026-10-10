#!/usr/bin/env node
// 单任务上传→预算→创建→轮询→下载→六帧；默认 dry-run。无登录态依赖，key 只读 env/指定文件。
// 已知坑：create 超时不重发，临时 URL 立即下载；预算为单次 CLI 硬上限，多项目需 D1 模板。验证：2026-10-04（仅假服务）。
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { args, keyFrom, api, curl, number, fail } from './kie-lib.mjs';
try {
 const o=args(process.argv.slice(2));
 if(o.help) console.log('node scripts/kie-generate.mjs --model ID --prompt-file FILE --params-file JSON --image FILE [--image FILE] --image-field reference_image_urls --expected-credits N --budget-credits N [--out DIR] [--base-url URL --upload-base-url URL] [--poll-ms N --timeout-ms N] [--env-file FILE] [--dry-run | --yes-spend]\n恢复：--resume --out DIR --base-url 原URL --yes-spend（仅查询/下载原taskId）。已有提交记录禁止覆盖；缺taskId的submitting须人工对账。默认 dry-run（不读 key、不请求）。真实执行必须 --yes-spend；输出 results.json。需 curl、ffprobe、ffmpeg。');
 else {
  const out=path.resolve(o.out||'kie-results');
  let previous;
  try {previous=JSON.parse(await readFile(path.join(out,'results.json'),'utf8'));}catch(e){if(e.code!=='ENOENT')throw Error('已有结果文件无法读取，禁止覆盖');}
  if(previous&&(previous.taskId||previous.status==='submitting')&&!o.resume)throw Error('已有提交记录，禁止覆盖或新建；带 taskId 时使用 --resume --out DIR');
  if(o.resume&&!previous?.taskId)throw Error('恢复需要已保存 taskId；提交不确定须人工对账，禁止重发');
  if(!o.resume&&(!o.model||!o['prompt-file']||!o['params-file']||!o.images.length||!o['image-field'])) throw Error('缺必需参数，请看 --help');
  const expected=number(o.resume?previous.expectedCredits:o['expected-credits'],'expected-credits'), budget=number(o.resume?previous.budgetCredits:o['budget-credits'],'budget-credits');
  if(expected<=0||expected>budget) throw Error('预算不足或预计积分无效');
  const params=o.resume?{}:JSON.parse(await readFile(o['params-file'],'utf8'));
  if(!params||Array.isArray(params)||typeof params!=='object') throw Error('params 必须为 JSON 对象');
  const prompt=o.resume?'':await readFile(o['prompt-file'],'utf8');
  for(const f of o.images) await readFile(f);
  const result=o.resume?{...previous,dryRun:!o['yes-spend']||!!o['dry-run']}:{jobId:randomUUID(),model:o.model,expectedCredits:expected,budgetCredits:budget,status:'dry-run',dryRun:!o['yes-spend']||!!o['dry-run'],startedAt:new Date().toISOString()};
  await mkdir(out,{recursive:true});
  const save=()=>writeFile(path.join(out,'results.json'),JSON.stringify(result,null,2));
  const poll=number(o['poll-ms']||2000,'poll-ms'), timeout=number(o['timeout-ms']||1800000,'timeout-ms');
  if(poll<=0||timeout<=0) throw Error('轮询间隔和时限必须大于零');
  await save();
  if(!result.dryRun) {
   const key=await keyFrom(o), base=o['base-url']||'https://api.kie.ai', upload=o['upload-base-url']||'https://kieai.redpandaai.co';
   result.keyPresent=true;
   if(o.resume&&result.baseUrl!==base)throw Error('恢复必须使用原 base-url，禁止跨供应商查询');
   try {
   if(!o.resume) {
    result.baseUrl=base;result.uploadBaseUrl=upload;result.uploads=[];
    result.initialBalance=number(api(base,'/api/v1/chat/credit',key),'余额');
    if(result.initialBalance<expected) throw Error('余额不足');
    const refs=[];
    for(const [index,file] of o.images.entries()) {
     const uploadPath='kie-reference/'+result.jobId,fileName=index+'-'+path.basename(file);
     let r;try {r=JSON.parse(curl(upload+'/api/file-stream-upload',key,['-F','file=@'+path.resolve(file),'-F','uploadPath='+uploadPath,'-F','fileName='+fileName]));}catch {throw Error('上传失败');}
     if(r.code!==200||!r.data?.downloadUrl) throw Error('上传回执无效');
     refs.push(r.data.downloadUrl);
     result.uploads.push({uploadPath,fileName,...r.data});await save();
    }
    result.beforeBalance=number(api(base,'/api/v1/chat/credit',key),'余额');
    if(result.beforeBalance<expected||Math.max(0,result.initialBalance-result.beforeBalance)+expected>budget) throw Error('提交前预算/余额阻断');
    result.status='submitting'; result.reservedCredits=expected; await save();
    const created=api(base,'/api/v1/jobs/createTask',key,{model:o.model,input:{...params,prompt,[o['image-field']]:refs}});
    if(!created?.taskId) throw Error('提交未确认，禁止重发');
    result.taskId=created.taskId;result.status='pending';await save();
   }
    const deadline=Date.now()+timeout;
    while(Date.now()<deadline) {
     await new Promise(r=>setTimeout(r,poll));
     let record;try {record=api(base,'/api/v1/jobs/recordInfo?taskId='+encodeURIComponent(result.taskId),key);} catch {result.pollErrors=(result.pollErrors||0)+1;await save();continue;}
     result.status=record.state;result.actualCredits=record.creditsConsumed??null;await save();
     if(record.state==='fail') throw Error('供应商任务失败，不自动换模型或重发');
     if(record.state==='success') {
      let urls;try {urls=(typeof record.resultJson==='string'?JSON.parse(record.resultJson):record.resultJson)?.resultUrls;}catch {throw Error('结果 JSON 无效');}
      if(!urls?.length) throw Error('成功回执缺少结果链接');
      result.files=[];
      for(let i=0;i<urls.length;i++) {
       const file=path.join(out,'output-'+i+'.mp4');
       // 下载临时链接不附带 API key。
       let bytes;try {bytes=execFileSync('curl',['-sS','--fail','--http1.1','--retry','2','--max-time','120',urls[i]],{maxBuffer:128*1024*1024,stdio:['ignore','pipe','pipe']});}catch {throw Error('下载失败，保留 taskId 后恢复下载');}
       await writeFile(file,bytes);
       let probe;try {probe=JSON.parse(execFileSync('ffprobe',['-v','error','-show_format','-show_streams','-of','json',file],{stdio:['ignore','pipe','pipe']}));}catch {throw Error('ffprobe 失败；图片/音频任务需按对应媒体类型验收');}
       await writeFile(path.join(out,'probe-'+i+'.json'),JSON.stringify(probe,null,2));
       const duration=Number(probe.format.duration), times=Array.from({length:6},(_,n)=>Math.max(0,duration-0.08)*n/5);
       for(let n=0;n<6;n++) {try {execFileSync('ffmpeg',['-v','error','-y','-ss',String(times[n]),'-i',file,'-frames:v','1','-vf','scale=640:-1',path.join(out,`output-${i}-frame-${n}.jpg`)],{stdio:['ignore','pipe','pipe']});}catch {throw Error('抽帧失败');}}
       result.files.push({file,bytes:bytes.length,keyframeTimes:times});
      }
      result.finalBalance=number(api(base,'/api/v1/chat/credit',key),'余额');
      result.balanceDelta=result.initialBalance-result.finalBalance;
      result.unattributedCredits=result.actualCredits===null?null:result.balanceDelta-result.actualCredits;
      if(Math.max(result.balanceDelta,result.actualCredits||0)>budget) throw Error('实际消费超过估算硬上限；停止后续任务并复核 SKU');
      result.status='completed';delete result.error;break;
     }
    }
    if(result.status!=='completed') throw Error('轮询到期；保留 taskId，只恢复查询，禁止重发');
   } catch(e) {result.error=e.message;await save();throw e;}
  }
  result.finishedAt=new Date().toISOString();await save();console.log(JSON.stringify({status:result.status,dryRun:result.dryRun,out}));
 }
} catch(e) { fail(e); }
