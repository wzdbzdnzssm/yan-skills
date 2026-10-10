import { KieClient } from "./kie-client"
// 参数均由项目配置；pause 至少覆盖单条峰值成本与并发预留，resume 高于 pause 构成迟滞。
export async function monitor(db: D1Database, kie: KieClient, p: {warn:number;pause:number;resume:number;totalLimit:number}, notify:(message:string,key:string)=>Promise<void>, now=Date.now()) {
  if (!(p.resume>p.pause && p.warn>=p.pause)) throw Error("Invalid thresholds")
  let balance:number
  try { balance=await kie.balance() } catch {
    await db.prepare("UPDATE kie_ops SET checked_at=?,failures=failures+1 WHERE id=1").bind(now).run();return
  }
  await db.prepare(`UPDATE kie_ops SET balance=?,checked_at=?,failures=0,
    paused=CASE WHEN ?<? THEN 1 WHEN ?>=? THEN 0 ELSE paused END WHERE id=1`)
    .bind(balance,now,balance,p.pause,balance,p.resume).run()
  const state=await db.prepare("SELECT reserved_micros FROM kie_ops WHERE id=1").first<{reserved_micros:number}>()
  if(balance>=p.warn && (state?.reserved_micros??0)<p.totalLimit*0.8) return
  const claimed=await db.prepare("UPDATE kie_ops SET alert_at=? WHERE id=1 AND (alert_at IS NULL OR alert_at<=?) RETURNING id").bind(now,now-86400000).first()
  if(!claimed)return
  try {await notify(`Kie balance=${balance}; reserved=${state?.reserved_micros}; review generation availability`, `kie-ops:${new Date(now).toISOString().slice(0,10)}`)}
  catch {await db.prepare("UPDATE kie_ops SET alert_at=NULL WHERE id=1 AND alert_at=?").bind(now).run()}
}
