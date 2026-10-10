// D1 batch 是事务；INSERT 的 changes() 链防止重复扣款或并发越过每日/总额。
export async function reserve(db: D1Database, p: {id:string;userId:string;siteCredits:number;micros:number;dailyLimit:number;totalLimit:number;day:string;sourceExpiresAt:number}) {
  if (![p.siteCredits,p.micros,p.dailyLimit,p.totalLimit].every(n=>Number.isSafeInteger(n)&&n>0)) throw Error("Invalid budget")
  const rows = await db.batch([
    db.prepare("INSERT OR IGNORE INTO kie_daily(day) VALUES (?)").bind(p.day),
    db.prepare(`INSERT OR IGNORE INTO kie_ledger(user_id,delta,ref)
      SELECT id,?,? FROM kie_users WHERE id=? AND credits>=?
      AND NOT EXISTS(SELECT 1 FROM kie_jobs WHERE id=?)
      AND (SELECT paused FROM kie_ops WHERE id=1)=0
      AND (SELECT reserved_micros FROM kie_daily WHERE day=?)+?<=?
      AND (SELECT reserved_micros FROM kie_ops WHERE id=1)+?<=?`)
      .bind(-p.siteCredits,`reserve:${p.id}`,p.userId,p.siteCredits,p.id,p.day,p.micros,p.dailyLimit,p.micros,p.totalLimit),
    db.prepare(`INSERT INTO kie_jobs(id,user_id,status,site_credits,budget_micros,day,source_expires_at)
      SELECT ?,?,'submitting',?,?,?,? WHERE changes()=1`)
      .bind(p.id,p.userId,p.siteCredits,p.micros,p.day,p.sourceExpiresAt),
    db.prepare("UPDATE kie_daily SET reserved_micros=reserved_micros+? WHERE day=? AND changes()=1").bind(p.micros,p.day),
  ])
  return rows[1].meta.changes > 0
}
export async function refund(db: D1Database, id: string, lease?: number) {
  const rows = await db.batch([
    db.prepare("UPDATE kie_jobs SET status='failed',lease_until=0 WHERE id=? AND status IN ('submitting','pending') AND (? IS NULL OR (lease_until=? AND lease_until>?))").bind(id,lease??null,lease??null,Date.now()),
    db.prepare(`INSERT OR IGNORE INTO kie_ledger(user_id,delta,ref)
      SELECT user_id,site_credits,'refund:'||id FROM kie_jobs WHERE id=? AND changes()=1`).bind(id),
  ])
  return rows[0].meta.changes > 0
  // 退的是产品积分；供应商是否退费另核对。失败仍保留成本预算预留。
}
