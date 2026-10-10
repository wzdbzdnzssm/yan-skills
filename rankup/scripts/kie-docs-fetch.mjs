#!/usr/bin/env node
// 公开官方 Markdown 抓取，不需要凭据；OpenAPI 围栏保留原文。验证：2026-10-04。
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { args, fail } from './kie-lib.mjs';
try {
 const argv=process.argv.slice(2); const fetchNow=argv.includes('--fetch');
 const o=args(argv.filter(a=>a!=='--fetch'));
 if(o.help) console.log('node scripts/kie-docs-fetch.mjs --url https://docs.kie.ai/PATH.md --out DIR [--dry-run | --fetch]\n默认 dry-run；--fetch 执行公开只读抓取（永不生成或花费）。');
 else {
  const u=new URL(o.url||'https://docs.kie.ai/llms.txt');
  if(u.origin!=='https://docs.kie.ai'||!(/\.(md|txt)$/.test(u.pathname)))throw Error('仅抓官方 .md/.txt');
  if(!fetchNow||o['dry-run']) console.log(JSON.stringify({dryRun:true,url:u.href}));
  else {
   let bytes;try {bytes=execFileSync('curl',['-fsSL','--http1.1','--retry','2','--max-time','60',u.href],{maxBuffer:20*1024*1024,stdio:['ignore','pipe','pipe']});}catch {throw Error('官方文档抓取失败');}
   const out=path.resolve(o.out||'kie-docs');await mkdir(out,{recursive:true});
   const file=path.join(out,u.pathname.slice(1).replaceAll('/','__'));await writeFile(file,bytes);
   await writeFile(file+'.source.json',JSON.stringify({url:u.href,fetchedAt:new Date().toISOString(),bytes:bytes.length}));
   console.log(JSON.stringify({file,bytes:bytes.length}));
  }
 }
} catch(e) {fail(e);}
