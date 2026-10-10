#!/usr/bin/env node
/**
 * 用途：竞品 sitemap 增量监控。竞品新布上去的长尾词页面，是它自己花钱调研出来的结论 ——
 *   盯住它的 sitemap，每周跑一次 diff，新增的 URL 就是它押注的新词。
 *   第一次跑只建快照（baseline），之后每次跑都会输出「新增 / 消失」的 URL。
 *   配合 --slug-words 还能直接把新增 URL 的 slug 拆成词频，一眼看出它在往哪个词族铺。
 *
 * 示例命令：
 *   node scripts/demand/sitemap-diff.mjs --domain example.com                 # 建 baseline
 *   node scripts/demand/sitemap-diff.mjs --domain example.com --json          # 之后每次跑出 diff
 *   node scripts/demand/sitemap-diff.mjs --domain example.com --include "/blog/" --limit 200
 *   node scripts/demand/sitemap-diff.mjs --sitemap https://example.com/sitemap_index.xml
 *   node scripts/demand/sitemap-diff.mjs --domain example.com --slug-words --top-words 40
 *   node scripts/demand/sitemap-diff.mjs --domain example.com --state ./my-snapshots --out new.jsonl
 *
 * 依赖：无 token、无登录态。纯公开 HTTP。
 * 已验证日期：2026-08-26
 *
 * 快照目录：--state <dir>，默认 `.rankup/demand/sitemap-snapshots/`（相对当前工作目录）。
 *   每个域名一个 `<域名>.json`，里面是 { fetchedAt, sitemaps[], urls[] }。
 *   建议把这个目录提交进版本库或挂进 CI cache，否则每次都会当成第一次跑。
 *
 * 已知坑：
 *   - sitemap 发现顺序：--sitemap 显式给的 → robots.txt 里的 `Sitemap:` 行 →
 *     常见兜底路径（/sitemap.xml、/sitemap_index.xml、/sitemap-index.xml、/sitemap.xml.gz）。
 *   - **sitemap index 会嵌套**（index 里套 index），脚本递归，默认深度上限 4、
 *     子 sitemap 数量上限 200（--max-sitemaps 调）。没有上限的话大站能拉爆内存。
 *   - **gzip**：以 .gz 结尾或响应 content-type/content-encoding 是 gzip 的，
 *     用 node:zlib 解压（gunzip 和 inflate 都试）。Node 的 fetch 会自动解 Content-Encoding: gzip，
 *     但**不会**解「文件本身就是 .gz」的情况，所以必须自己解。
 *   - 有的站 sitemap 是 XML 但返回 text/html 的 content-type，不要按 content-type 判断，
 *     直接看正文有没有 <urlset / <sitemapindex。
 *   - 有的站在 sitemap 上挡爬虫（403）。脚本带浏览器 UA；还挡就只能人工看，或走 OpenCLI。
 *   - 大站 sitemap 可能几十万条 URL，diff 是全量比对，内存里放 Set，注意机器内存。
 *   - 只比对 `<loc>`，不比对 lastmod。想看「内容更新」而不是「新增页面」，用 --track-lastmod，
 *     它会把 lastmod 一起存进快照并在 diff 里报告 changed。
 */

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { parseArgs, get, emit, die, sleep } from './_lib.mjs';

const HELP = `
sitemap-diff.mjs — 竞品 sitemap 增量监控（新增的长尾页 = 它押注的新词）

用法:
  node sitemap-diff.mjs --domain <domain> [选项]
  node sitemap-diff.mjs --sitemap <url> [选项]

选项:
  --domain <d>       目标域名（会自动从 robots.txt 找 sitemap）
  --sitemap <u>      直接指定 sitemap URL，可重复；给了就不再猜
  --state <dir>      快照目录（默认 .rankup/demand/sitemap-snapshots/，相对当前工作目录）
  --name <n>         快照文件名（默认取域名）
  --include <re>     只保留匹配这个正则的 URL，可重复
  --exclude <re>     排除匹配这个正则的 URL，可重复
  --exclude-sitemap <re> 跳过匹配这个正则的子 sitemap，可重复
  --limit <n>        最多输出多少条新增（默认 500）
  --max-sitemaps <n> 最多抓多少个子 sitemap（默认 200）
  --max-depth <n>    sitemap index 递归深度上限（默认 4）
  --delay <ms>       抓子 sitemap 之间的间隔（默认 300，别把人家打挂）
  --track-lastmod    快照里记录 lastmod，diff 时额外报告 changed
  --all              输出全部 URL 而不是 diff（第一次调研用）
  --slug-words       额外统计新增 URL 的 slug 词频（看它在铺哪个词族）
  --top-words <n>    --slug-words 显示多少个词（默认 30）
  --self-test        运行离线解析检查
  --no-save          只看 diff，不更新快照
  --json / --out <f>
  --help

产出字段:
  status(added|removed|changed|all), url, lastmod, sitemap
  --slug-words 时额外在 stderr 打印词频表
`.trim();

const BROWSER_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const FALLBACKS = ['/sitemap.xml', '/sitemap_index.xml', '/sitemap-index.xml', '/sitemap.xml.gz', '/sitemap1.xml'];

const decode = (s) => String(s)
  .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
  .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
  .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(+d))
  .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
  .trim();

const xmlEscape = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function markdownSitemap(markdown) {
  if (!/^Title:\s*Sitemap(?: Index)?\s*$/im.test(markdown) || /Warning:.*(?:[45]\d\d|error)/i.test(markdown)) return null;
  const lines = String(markdown).split(/\r?\n/);
  const rows = [];
  for (let i = 0; i < lines.length; i++) {
    const match = lines[i].match(/^\[[^\]]*\]\((https?:\/\/[^)]+)\)\s*$/);
    if (!match) continue;
    const next = lines.slice(i + 1, i + 4).find((line) => /^\d{4}-\d{2}-\d{2}/.test(line.trim()));
    rows.push({ url: match[1], lastmod: next?.trim() ?? '' });
  }
  const unique = [...new Map(rows.map((row) => [row.url, row])).values()];
  if (!unique.length) return null;
  const index = /^Title:\s*Sitemap Index/im.test(markdown);
  const item = index ? 'sitemap' : 'url';
  const root = index ? 'sitemapindex' : 'urlset';
  return `<${root}>${unique.map((row) => `<${item}><loc>${xmlEscape(row.url)}</loc>${row.lastmod ? `<lastmod>${xmlEscape(row.lastmod)}</lastmod>` : ''}</${item}>`).join('')}</${root}>`;
}

/** 取一个 sitemap，处理 .gz 与各种奇怪 content-type */
async function fetchSitemap(url) {
  try {
    const res = await get(url, { ua: BROWSER_UA, headers: { accept: 'application/xml,text/xml,*/*' }, timeout: 45000 });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    const gzipish = url.endsWith('.gz')
      || (buf[0] === 0x1f && buf[1] === 0x8b)
      || /gzip/i.test(res.headers.get('content-type') ?? '');
    if (gzipish) {
      for (const fn of [zlib.gunzipSync, zlib.inflateSync, zlib.inflateRawSync]) {
        try { return { text: fn(buf).toString('utf8'), fallback: null }; } catch { /* 换下一种 */ }
      }
    }
    return { text: buf.toString('utf8'), fallback: null };
  } catch (directError) {
    const reader = await get(`https://r.jina.ai/${url}`, { ua: 'agent-reach/1.0', timeout: 45000 });
    if (!reader.ok) throw directError;
    const text = markdownSitemap(await reader.text());
    if (!text) throw directError;
    return { text, fallback: `Jina Reader（直连失败：${directError.message}）` };
  }
}

/** 递归展开 sitemap index，返回 { urls: Map<loc, {lastmod, sitemap}>, sitemaps: [] } */
async function crawl(startUrls, { maxSitemaps, maxDepth, delay, excludeSitemaps }) {
  const urls = new Map();
  const sitemaps = [];
  const seen = new Set();
  const queue = startUrls.map((u) => ({ url: u, depth: 0 }));
  const errors = [];
  const fallbacks = [];

  while (queue.length && sitemaps.length < maxSitemaps) {
    const { url, depth } = queue.shift();
    if (seen.has(url) || depth > maxDepth) continue;
    seen.add(url);
    let fetched;
    try { fetched = await fetchSitemap(url); }
    catch (e) { errors.push(`${url} :: ${e.message}`); continue; }
    const xml = fetched.text;
    if (fetched.fallback) fallbacks.push({ url, via: fetched.fallback });
    sitemaps.push(url);

    const isIndex = /<sitemapindex[\s>]/i.test(xml);
    const blocks = xml.split(/<(?:url|sitemap)[\s>]/i).slice(1);
    if (!blocks.length && !/<urlset[\s>]/i.test(xml) && !isIndex) {
      errors.push(`${url} :: 正文看起来不是 sitemap（前 80 字：${xml.slice(0, 80).replace(/\s+/g, ' ')}）`);
      continue;
    }
    for (const b of blocks) {
      const loc = (b.match(/<loc>([\s\S]*?)<\/loc>/i) || [])[1];
      if (!loc) continue;
      const clean = decode(loc);
      if (isIndex) {
        if (!excludeSitemaps.some((re) => re.test(clean))) queue.push({ url: clean, depth: depth + 1 });
      } else if (!urls.has(clean)) {
        const lm = (b.match(/<lastmod>([\s\S]*?)<\/lastmod>/i) || [])[1];
        urls.set(clean, { lastmod: lm ? decode(lm) : '', sitemap: url });
      }
    }
    if (queue.length) await sleep(delay);
  }
  return { urls, sitemaps, errors, fallbacks, truncated: queue.length > 0 };
}

async function discover(domain) {
  const host = domain.replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  const found = [];
  for (const scheme of ['https', 'http']) {
    try {
      const res = await get(`${scheme}://${host}/robots.txt`, { ua: BROWSER_UA, retries: 1, timeout: 20000 });
      if (!res.ok) continue;
      const txt = await res.text();
      for (const m of txt.matchAll(/^\s*sitemap:\s*(\S+)\s*$/gim)) found.push(m[1].trim());
      if (found.length) return { origin: `${scheme}://${host}`, sitemaps: [...new Set(found)], via: 'robots.txt' };
      return { origin: `${scheme}://${host}`, sitemaps: [], via: 'robots.txt（里面没有 Sitemap: 行）' };
    } catch { /* 换 http 再试 */ }
  }
  return { origin: `https://${host}`, sitemaps: [], via: 'robots.txt 取不到' };
}

function slugWords(urls, topN) {
  const stop = new Set(['www', 'com', 'http', 'https', 'html', 'htm', 'php', 'index', 'page', 'the', 'a', 'an',
    'and', 'or', 'of', 'for', 'to', 'in', 'on', 'with', 'your', 'you', 'is', 'it', 'at', 'by', 'from']);
  const freq = new Map();
  for (const u of urls) {
    let p;
    try { p = new URL(u).pathname; } catch { continue; }
    for (const w of p.toLowerCase().split(/[^a-z0-9]+/)) {
      if (!w || w.length < 3 || stop.has(w) || /^\d+$/.test(w)) continue;
      freq.set(w, (freq.get(w) ?? 0) + 1);
    }
  }
  return [...freq.entries()].sort((a, b) => b[1] - a[1]).slice(0, topN);
}

async function main() {
  const args = parseArgs();
  if (args.help || args.h) { console.log(HELP); return; }
  if (args['self-test']) {
    const parsed = markdownSitemap('Title: Sitemap Index\n\n[https://example.com/games.xml](https://example.com/games.xml)\n\n2026-08-26');
    if (!parsed?.includes('<sitemapindex>') || !parsed.includes('<lastmod>2026-08-26</lastmod>')) die('Jina sitemap 解析检查失败');
    if (markdownSitemap('Title: Not Found\n[home](https://example.com/)') !== null || markdownSitemap('Title: Sitemap\nWarning: Target URL returned error 404\n[home](https://example.com/)') !== null) die('Jina 错误页不能生成 sitemap baseline');
    console.log('sitemap-diff self-test passed');
    return;
  }

  const explicit = [].concat(args.sitemap ?? []).map(String);
  const domain = args.domain ? String(args.domain).replace(/^https?:\/\//, '').replace(/\/.*$/, '') : '';
  if (!explicit.length && !domain) die('至少给 --domain 或 --sitemap');

  let starts = explicit;
  if (!starts.length) {
    const d = await discover(domain);
    starts = d.sitemaps;
    if (!starts.length) {
      if (!args.json) console.error(`# ${d.via}，改试常见路径`);
      for (const p of FALLBACKS) {
        try {
          const res = await get(d.origin + p, { ua: BROWSER_UA, retries: 0, timeout: 15000 });
          if (res.ok) {
            const head = (await res.text()).slice(0, 400);
            if (/<urlset|<sitemapindex/i.test(head) || p.endsWith('.gz')) { starts = [d.origin + p]; break; }
          }
        } catch { /* 下一个 */ }
      }
    } else if (!args.json) {
      console.error(`# 从 ${d.via} 找到 ${starts.length} 个 sitemap`);
    }
    if (!starts.length) die(`没找到 ${domain} 的 sitemap（robots.txt 里没有，常见路径也都不是）。用 --sitemap 手动指定。`);
  }

  const excludeSitemaps = [].concat(args['exclude-sitemap'] ?? []).map((value) => new RegExp(String(value)));
  const { urls, sitemaps, errors, fallbacks, truncated } = await crawl(starts, {
    maxSitemaps: Number(args['max-sitemaps'] ?? 200),
    maxDepth: Number(args['max-depth'] ?? 4),
    delay: Number(args.delay ?? 300),
    excludeSitemaps,
  });
  for (const e of errors) console.error(`抓取失败：${e}`);
  for (const f of fallbacks) console.error(`降级抓取：${f.url} → ${f.via}`);
  if (truncated) console.error(`注意：达到 --max-sitemaps 上限，还有子 sitemap 没抓完，结果不完整`);
  if (!urls.size) die('一条 <loc> 都没解析出来 —— 可能被 403 挡了，或者这个 sitemap 是空的');

  // 过滤
  const inc = [].concat(args.include ?? []).map((r) => new RegExp(String(r)));
  const exc = [].concat(args.exclude ?? []).map((r) => new RegExp(String(r)));
  const keep = (u) => (!inc.length || inc.some((r) => r.test(u))) && !exc.some((r) => r.test(u));
  const current = new Map([...urls].filter(([u]) => keep(u)));

  // 快照
  const stateDir = path.resolve(process.cwd(), String(args.state ?? '.rankup/demand/sitemap-snapshots'));
  const name = String(args.name ?? domain ?? new URL(starts[0]).hostname).replace(/[^\w.-]/g, '_');
  const file = path.join(stateDir, `${name}.json`);
  const trackLastmod = !!args['track-lastmod'];

  let prev = null;
  try { prev = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* 第一次跑 */ }

  const snapshot = {
    fetchedAt: new Date().toISOString(),
    source: starts,
    sitemaps,
    count: current.size,
    urls: trackLastmod
      ? Object.fromEntries([...current].map(([u, v]) => [u, v.lastmod]))
      : [...current.keys()],
  };

  const limit = Number(args.limit ?? 500);
  let rows;
  if (args.all || !prev) {
    rows = [...current].slice(0, limit).map(([u, v]) => ({ status: 'all', url: u, lastmod: v.lastmod, sitemap: v.sitemap }));
    if (!prev && !args.json) {
      console.error(`# 第一次跑，已建立 baseline（${current.size} 条 URL）→ ${file}`);
      console.error('# 下次再跑同一条命令就会输出新增/消失的 URL。');
    }
  } else {
    const prevUrls = Array.isArray(prev.urls) ? new Map(prev.urls.map((u) => [u, ''])) : new Map(Object.entries(prev.urls ?? {}));
    rows = [];
    for (const [u, v] of current) {
      if (!prevUrls.has(u)) rows.push({ status: 'added', url: u, lastmod: v.lastmod, sitemap: v.sitemap });
      else if (trackLastmod && prevUrls.get(u) && v.lastmod && prevUrls.get(u) !== v.lastmod) {
        rows.push({ status: 'changed', url: u, lastmod: v.lastmod, prevLastmod: prevUrls.get(u), sitemap: v.sitemap });
      }
    }
    for (const u of prevUrls.keys()) if (!current.has(u)) rows.push({ status: 'removed', url: u, lastmod: '', sitemap: '' });
    rows.sort((a, b) => (a.status === b.status ? 0 : a.status === 'added' ? -1 : b.status === 'added' ? 1 : 0));
    if (!args.json) {
      const n = (s) => rows.filter((r) => r.status === s).length;
      console.error(`# 对比 ${prev.fetchedAt}：新增 ${n('added')} / 消失 ${n('removed')}`
        + (trackLastmod ? ` / 更新 ${n('changed')}` : '') + `（当前共 ${current.size} 条）`);
    }
    rows = rows.slice(0, limit);
  }

  if (!args['no-save']) {
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(file, JSON.stringify(snapshot, null, 2) + '\n');
  }

  if (args['slug-words']) {
    const added = rows.filter((r) => r.status === 'added' || r.status === 'all').map((r) => r.url);
    const words = slugWords(added, Number(args['top-words'] ?? 30));
    console.error('\n# 新增 URL 的 slug 词频（它在铺哪个词族）');
    for (const [w, c] of words) console.error(`  ${String(c).padStart(4)}  ${w}`);
    console.error('');
  }

  emit(rows, args, [
    { key: 'status', label: '状态', max: 8 },
    { key: 'lastmod', label: 'lastmod', max: 26 },
    { key: 'url', label: 'URL', max: 110 },
  ]);
}

main().catch((e) => die(e.message));
