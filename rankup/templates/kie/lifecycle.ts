import { KieClient, resultUrls, verifyWebhook } from "./kie-client"
import { refund } from "./budget"
type Job={id:string;task_id:string|null;status:string;photo_keys:string;source_expires_at:number;output_keys:string|null}
export type Env={DB:D1Database;PHOTOS:R2Bucket;OUTPUTS:R2Bucket;KIE_API_KEY:string;KIE_WEBHOOK_HMAC_KEY:string}
export async function deleteSources(env:Env,job:Job) {
  await env.PHOTOS.delete(JSON.parse(job.photo_keys))
  await env.DB.prepare("UPDATE kie_jobs SET photos_deleted_at=? WHERE id=?").bind(Date.now(),job.id).run()
}
// Cron 和 webhook 共用带租约的终态处理；R2 先完成，D1 后完成，失败下载保留 pending。
export async function settle(env:Env,kie:KieClient,id:string) {
 const now=Date.now()
 const job=await env.DB.prepare("UPDATE kie_jobs SET lease_until=? WHERE id=? AND status='pending' AND lease_until<? RETURNING *").bind(now+180000,id,now).first<Job>()
 if(!job?.task_id)return
 try {
  const record=await kie.record(job.task_id)
  if(record.state==='fail') {if(await refund(env.DB,id,now+180000))await deleteSources(env,job);return}
  if(record.state!=='success')return
  const keys:string[]=[]
  for(const [i,url] of resultUrls(record).entries()) {
   const response=await fetch(url,{signal:AbortSignal.timeout(30000)})
   if(!response.ok||!response.body)throw Error("Output download failed")
   const key=`output/${id}/${i}`
   await env.OUTPUTS.put(key,response.body,{httpMetadata:{contentType:response.headers.get('content-type')||'application/octet-stream'}})
   keys.push(key)
  }
  // 处理超出租约或已被接管时，旧执行者不得提交终态、退款或删除源图。
  const completed=await env.DB.prepare("UPDATE kie_jobs SET status='completed',output_keys=?,cost_credits=? WHERE id=? AND status='pending' AND lease_until=? AND lease_until>?").bind(JSON.stringify(keys),record.creditsConsumed??null,id,now+180000,Date.now()).run()
  if(completed.meta.changes>0)await deleteSources(env,job)
 } finally {await env.DB.prepare("UPDATE kie_jobs SET lease_until=0 WHERE id=? AND lease_until=?").bind(id,now+180000).run()}
}
export async function callback(request:Request,env:Env,kie:KieClient) {
 const taskId=await verifyWebhook(request,env.KIE_WEBHOOK_HMAC_KEY)
 const row=await env.DB.prepare("SELECT id FROM kie_jobs WHERE task_id=?").bind(taskId).first<{id:string}>()
 if(row)await settle(env,kie,row.id)
 return new Response('ok')
}
export async function cron(env:Env,kie:KieClient,notify:(jobId:string,idempotencyKey:string)=>Promise<void>) {
 const rows=await env.DB.prepare("SELECT id FROM kie_jobs WHERE status='pending' LIMIT 100").all<{id:string}>()
 for(const row of rows.results) {try {await settle(env,kie,row.id)}catch {/* 查询/下载失败只重读同任务 */}}
 const terminal=await env.DB.prepare("SELECT id FROM kie_jobs WHERE status IN ('completed','failed') AND notified_at IS NULL LIMIT 100").all<{id:string}>()
 // 邮件通道必须支持 idempotency key，跨 cron 并发不会重复发信。
 for(const row of terminal.results) {
  try {await notify(row.id,`kie-result:${row.id}`);await env.DB.prepare("UPDATE kie_jobs SET notified_at=? WHERE id=?").bind(Date.now(),row.id).run()}
  catch {/* 保留未通知状态，下轮重试；邮件故障不阻止源图清理。 */}
 }
 const photos=await env.DB.prepare("SELECT * FROM kie_jobs WHERE photos_deleted_at IS NULL AND (source_expires_at<=? OR status IN ('completed','failed'))").bind(Date.now()).all<Job>()
 for(const row of photos.results)await deleteSources(env,row)
}
