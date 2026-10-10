# Kie Worker 复制包

本包定点同步自 `yan-labs/yan-skills` 上游 commit `8e35596dc2cd08945f4e85654609b5de54a758ae`，并补充 Windows 本地验证、恢复防重提交与租约终态校验；未整体合并上游。

复制这些文件到产品后端，按产品已有用户表、账本表、邮件通道对接。使用 Worker 原生 fetch/Web Crypto，D1 和 R2 类型来自项目的 Cloudflare 类型生成。每个文件只实现一个职责；架构和边界的唯一说明见 [分支入口](../../references/integrations/kie.md)。这不是可直接发布的完整站点。

| 文件 | 用途 |
|---|---|
| [kie-client.ts](kie-client.ts) | 上传、创建、查询、余额、HMAC |
| [migration.sql](migration.sql) | 示例表、唯一账本键、预算累计触发器 |
| [budget.ts](budget.ts) | D1 原子每日/总预算预留、产品积分退款 |
| [ops.ts](ops.ts) | 余额阈值、迟滞、每日告警去重 |
| [lifecycle.ts](lifecycle.ts) | webhook/cron 共用结算、R2、通知与照片清理 |
| [local-verify.mjs](local-verify.mjs) | Miniflare D1/R2 零花费验证脚手架 |

接线顺序：用户请求携带稳定幂等 job id → reserve 成功 → 原照片放私有 PHOTOS，并更新 photo_keys → Kie upload → create 一次 → 持久化 task_id/status=pending → webhook/cron 调用 settle。读取重复 job id 前必须核对已登录用户与 job.user_id 一致，避免碰撞 ID 泄露他人任务；reserve=false 时不调用供应商。上传已明确失败可 refund；create 连接中断或响应缺 taskId 属于提交不确定，保留 submitting，人工/供应商对账后处理，不自动退款并重发。

源图签名 URL 若使用自有 R2：只允许未过 source_expires_at 的受控下载；任务结束立刻删除。Kie file-upload 是供应商暂存，不能以本地删除宣称供应商同步物理删除。输出保留期与账号删除由产品现有机制接入；R2 下载重试可能产生孤儿对象，按 job 前缀对账清理。cron 先 monitor 再 cron；pause 仅拦新提交，已有任务继续结算。

本地验证不安装依赖：指定已安装 Wrangler 的项目 --deps-project，使用其 Miniflare/esbuild；假服务地址通过 env 注入，测试凭据仅内存里的固定假值；不改项目文件。生产 secrets 由部署通道注入，不放 vars。

```sh
node templates/kie/local-verify.mjs --deps-project /path/to/web --out /path/to/evidence.json
```

复制到产品后最小接线示例：`new KieClient(env.KIE_API_KEY)`；callback URL 是产品地址。本地脚手架使用真实 Miniflare D1/R2，覆盖 budget/ops/HMAC、成功/失败结算、下载失败恢复、并发与过期租约、通知重试和源图清理。兼容日期默认 2026-09-01，可用 `--compatibility-date` 指定现有 workerd 支持的日期；不升级运行时。该验证只证明模板与假出站行为，不能代替产品用户流程或真实供应商样片。

## CLI 假服务复刻

环境需要 Node、curl、ffmpeg/ffprobe；在临时证据目录准备任意授权PNG、prompt.txt、params.json。以下 `scripts/`、`templates/` 命令从仓库的 `rankup/` 目录运行。先运行下面的本地服务（第二个终端运行CLI，结束Ctrl-C关闭）。假服务媒体可用 ffmpeg 的 color 生成，既不访问模型也不花费。

```sh
ffmpeg -v error -y -f lavfi -i color=c=orange:s=320x180:d=2 -c:v libx264 -pix_fmt yuv420p /path/to/fixture.mp4
node scripts/kie-fake-server.mjs --port 8789 --balance 1000 --cost 82 --media-file /path/to/fixture.mp4
# 默认dry-run，不读取key或发网络请求：
node scripts/kie-generate.mjs --model bytedance/seedance-2-mini --prompt-file /path/to/prompt.txt --params-file /path/to/params.json --image /path/to/input.png --image-field reference_image_urls --expected-credits 82 --budget-credits 100 --out /path/to/dry-run
# 仅本地假服务端到端：
KIE_API_KEY=local-fixture node scripts/kie-generate.mjs --model bytedance/seedance-2-mini --prompt-file /path/to/prompt.txt --params-file /path/to/params.json --image /path/to/input.png --image-field reference_image_urls --expected-credits 82 --budget-credits 100 --base-url http://localhost:8789 --upload-base-url http://localhost:8789 --poll-ms 50 --timeout-ms 5000 --out /path/to/completed --yes-spend
curl -fsS http://localhost:8789/__stats
```

params.json 示例：`{"duration":2,"resolution":"720p","aspect_ratio":"16:9"}`，仅假媒体测试；真实模型最短时长与报价见模型表，不拿这个2秒fixture请求真实Mini。`--yes-spend` 是显式提交开关，不能单凭有key就触发；真实请求前需明确授权预算。假余额/失败状态用 `POST /__control` 的 `{balance:40}` 或 `{states:["waiting","fail"]}` 注入（JSON键用双引号），计数证明新任务是否被阻断。

Windows PowerShell 从仓库根目录直接执行下面的零费用回归：

```powershell
$env:KIE_TEST_OUT = Join-Path $env:TEMP 'kie-local-evidence'
node --test rankup/tests/kie-cli.test.mjs
# 从 rankup/ 目录手动执行 CLI 时，先设置假值，再运行上面的 node 命令：
$env:KIE_API_KEY = 'local-fixture'
```

不要用 POSIX 的 `KIE_API_KEY=... node ...`。命令需要 PATH 中已有 Node、curl.exe、ffprobe、ffmpeg，不会自动安装。回归覆盖真实本地 curl→假 Kie→MP4/probe/六帧；输出为 ffmpeg 生成的纯色测试视频，**不是 AI 样片**。重复跑回归需另选空证据目录（CLI 会保护已有提交记录）。

CLI 为每次 job 分配独立上传目录与参考序号文件名，保存上传回执；供应商同目录同名文件可能覆盖，不复用固定路径。已有 taskId 或 submitting 的 `results.json` 禁止原命令覆盖和新建；轮询超时/下载失败使用 `--resume --out 原目录 --base-url 原地址 --yes-spend`，只查询/下载同任务，沿用原预算。无 taskId 的不确定提交只能人工对账；删除结果文件或换输出目录会失去 CLI 防重保护，因此产品仍需持久账本。

CLI 的结果文件保护只适用于串行单进程；不要对同一输出目录并发运行。多进程/多用户并发须接产品持久原子账本。用户归属检查是产品接线要求，本地模板测试不包含认证系统。

## 实际产品仍需对接

- CLI 凭据为 `KIE_API_KEY`（或显式 `--env-file`）；Worker secrets 为 `KIE_API_KEY`、`KIE_WEBHOOK_HMAC_KEY`，bindings 为 `DB`、`PHOTOS`、`OUTPUTS`。生产不能沿用假 key。
- 产品路由、用户认证与 job 归属、支付/产品积分账本、私有照片上传及签名 URL、create 后 taskId 持久化、callback URL、cron 调度、邮件幂等通道和输出保留/账号删除机制均需产品接线；模板不含可发布站点。
- 模型 enum、参考图字段、时长/分辨率与报价需逐模型核实；音频和专用协议不在本 CLI 验收范围。真实 HMAC 回调送达、真实消费及质量必须经当前任务付费授权后另验，本地样片不能证明身份保持、动作或音画质量。
- 2026-10-10 [官方上传文档](https://docs.kie.ai/file-upload-api/upload-file-stream)标明暂存 24 小时、[任务查询文档](https://docs.kie.ai/market/common/get-task-detail)标明结果 URL 14 天；仍应及时下载至自有存储，并核实实际模型行为。本地删除 R2 源图不能宣称供应商已物理删除。
