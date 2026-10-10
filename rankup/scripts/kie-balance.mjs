#!/usr/bin/env node
// 只读 Kie 余额；环境 KIE_API_KEY 或 --env-file，默认不依赖登录态。已知坑：代理/TLS 用 curl HTTP/1.1。验证：2026-10-04。
import { args, keyFrom, api, number, fail } from './kie-lib.mjs';
try {
 const o=args(process.argv.slice(2));
 if(o.help) console.log('node scripts/kie-balance.mjs [--env-file FILE] [--base-url URL] [--json] [--threshold CREDITS] [--dry-run]\n低于 threshold 退出 2；dry-run 不发请求。');
 else {
  const threshold=o.threshold===undefined?null:number(o.threshold,'threshold');
  const key=await keyFrom(o);
  const result={keyPresent:!!key,dryRun:!!o['dry-run']};
  if(!o['dry-run']) {
   result.credits=number(api(o['base-url']||'https://api.kie.ai','/api/v1/chat/credit',key),'余额');
   result.belowThreshold=threshold!==null && result.credits<threshold;
   if(result.belowThreshold) process.exitCode=2;
  }
  console.log(o.json?JSON.stringify(result):`KIE_API_KEY：存在；${result.dryRun?'dry-run，无请求':'余额 '+result.credits+' 积分'}`);
 }
} catch(e) { fail(e); }
