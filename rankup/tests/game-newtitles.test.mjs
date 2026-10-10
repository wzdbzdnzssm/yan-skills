import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {spawnSync} from 'node:child_process';
const script=fileURLToPath(new URL('../scripts/demand/game-newtitles.mjs',import.meta.url));
function fixture(html,args,tz){const root=fs.mkdtempSync(path.join(os.tmpdir(),'game source fixture '));try{const preload=path.join(root,'fetch.mjs');fs.writeFileSync(preload,`globalThis.fetch=async()=>new Response(${JSON.stringify(html)},{status:200});`);const r=spawnSync(process.execPath,['--import',pathToFileURL(preload).href,script,...args,'--json'],{cwd:root,encoding:'utf8',env:{...process.env,TZ:tz}});assert.equal(r.status,0,r.stderr);return JSON.parse(r.stdout);}finally{fs.rmSync(root,{recursive:true,force:true});}}
test('Steam calendar dates remain unchanged across east and west time zones',()=>{
  const html='<a href="https://store.steampowered.com/app/1/Foo/" data-ds-appid="1"><span class="title">Foo</span><div class="search_released">Oct 9, 2026</div></a>';
  for(const tz of ['Asia/Shanghai','America/Los_Angeles'])assert.equal(fixture(JSON.stringify({results_html:html}),['--source','steam','--count','1','--sleep','0'],tz)[0].date,'2026-10-09');
});
test('Poki basic-game filter excludes popular sidebar tiles before limit',()=>{
  const html='<a data-tile-url="/en/g/old" data-tile-list="popularWeekGames"><span class="summaryTile__title">Old</span></a><a data-tile-url="/en/g/new" data-tile-list="basic-game"><span class="summaryTile__title">New</span></a>';
  const rows=fixture(html,['--source','poki','--tile-list','basic-game','--count','1'],'Asia/Shanghai');
  assert.equal(rows.length,1);assert.equal(rows[0].name,'New');assert.equal(rows[0].extra.list,'basic-game');
});
