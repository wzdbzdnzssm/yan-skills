// Kie CLI 共用：参数、受控凭据、HTTP/1.1；不输出上游正文或凭据。验证：2026-10-04。
import { readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
export function args(argv) {
  const out = { images: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (['--help','--dry-run','--yes-spend','--json','--resume'].includes(a)) out[a.slice(2)] = true;
    else if (a === '--image') out.images.push(argv[++i]);
    else if (a.startsWith('--') && argv[i+1] && !argv[i+1].startsWith('--')) out[a.slice(2)] = argv[++i];
    else throw Error('参数无效');
  }
  return out;
}
export async function keyFrom(o) {
  let key = process.env.KIE_API_KEY;
  if (!key && o['env-file']) {
    const raw = await readFile(o['env-file'], 'utf8');
    key = raw.match(/^\s*(?:export\s+)?KIE_API_KEY\s*=\s*(.*?)\s*$/m)?.[1]?.replace(/^(['"])(.*)\1$/, '$2');
  }
  if (!key) throw Error('KIE_API_KEY 不存在');
  if (/[\r\n]/.test(key)) throw Error('凭据格式无效');
  return key;
}
export function number(value, name) {
  const n = Number(value);
  if (value === undefined || !Number.isFinite(n) || n < 0) throw Error(name+' 必须为非负数');
  return n;
}
export function curl(url, key, extra = []) {
  // key 仅由 stdin 输入 curl config，不进入 argv；stderr 永不转发。
  const escaped = key.replace(/\\/g,'\\\\').replace(/"/g,'\\"');
  try {
    return execFileSync('curl', ['--silent','--show-error','--fail-with-body','--http1.1','--max-time','120',
      '--config','-', ...extra, url], {
      input: `header = "Authorization: Bearer ${escaped}"\n`,
      maxBuffer: 128*1024*1024, stdio:['pipe','pipe','pipe']
    });
  } catch { throw Error('HTTP 传输失败；未确认提交时禁止重发'); }
}
export function api(base, route, key, body) {
  const extra = body ? ['-H','Content-Type: application/json','--data-binary',JSON.stringify(body)] : [];
  let receipt;
  try { receipt = JSON.parse(curl(base+route,key,extra)); } catch { throw Error('HTTP/API 响应不可用；不重发创建请求'); }
  if (receipt.code !== 200) throw Error('Kie API code='+Number(receipt.code));
  return receipt.data;
}
export function fail(error) {
  // 只输出本地固定消息，调用者不可传入未过滤的上游消息。
  console.error(error.message); process.exitCode = 1;
}
