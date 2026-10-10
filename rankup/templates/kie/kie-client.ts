// Worker Kie 客户端；密钥由 Worker secrets 注入。模型参数不在客户端改写。
export type KieRecord = { taskId: string; state: string; resultJson?: string | {resultUrls: string[]}; creditsConsumed?: number; failCode?: string }
export class KieClient {
  constructor(private key: string, private apiBase = "https://api.kie.ai", private uploadBase = "https://kieai.redpandaai.co") {}
  private async request<T>(url: string, init: RequestInit = {}): Promise<T> {
    const response = await fetch(url, {...init, headers: {...init.headers, Authorization: `Bearer ${this.key}`}, signal: AbortSignal.timeout(30000)})
    const receipt = await response.json() as {code: number; data: T}
    if (!response.ok || receipt.code !== 200) throw new Error(`Kie code ${receipt.code || response.status}`)
    return receipt.data
  }
  upload(file: Blob, fileName: string, uploadPath: string) {
    const form = new FormData(); form.set("file", file, fileName); form.set("fileName", fileName); form.set("uploadPath", uploadPath)
    return this.request<{downloadUrl: string}>(`${this.uploadBase}/api/file-stream-upload`, {method: "POST", body: form})
  }
  create(model: string, input: Record<string, unknown>, callBackUrl?: string) {
    // 不重试：连接中断时供应商可能已经受理。
    return this.request<{taskId: string}>(`${this.apiBase}/api/v1/jobs/createTask`, {method: "POST", headers: {"Content-Type":"application/json"}, body: JSON.stringify({model,input,...(callBackUrl?{callBackUrl}:{})})})
  }
  record(taskId: string) { return this.request<KieRecord>(`${this.apiBase}/api/v1/jobs/recordInfo?taskId=${encodeURIComponent(taskId)}`) }
  async balance() { const value = await this.request<number>(`${this.apiBase}/api/v1/chat/credit`); if (!Number.isFinite(value) || value < 0) throw Error("Invalid balance"); return value }
}
export function resultUrls(record: KieRecord): string[] {
  const data = typeof record.resultJson === "string" ? JSON.parse(record.resultJson) : record.resultJson
  if (!Array.isArray(data?.resultUrls) || !data.resultUrls.length) throw Error("Missing result URLs")
  return data.resultUrls
}
export async function verifyWebhook(request: Request, hmacSecret: string, nowSeconds = Date.now()/1000): Promise<string> {
  const body = await request.json() as {data?: {taskId?: string}}
  const taskId = body.data?.taskId, timestamp = request.headers.get("X-Webhook-Timestamp"), signature = request.headers.get("X-Webhook-Signature")
  if (!taskId || !timestamp || !signature || !Number.isSafeInteger(Number(timestamp)) || Math.abs(nowSeconds-Number(timestamp))>300) throw Error("Invalid callback")
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(hmacSecret), {name:"HMAC",hash:"SHA-256"}, false, ["verify"])
  const bytes = Uint8Array.from(atob(signature), c=>c.charCodeAt(0))
  if (!await crypto.subtle.verify("HMAC",key,bytes,new TextEncoder().encode(`${taskId}.${timestamp}`))) throw Error("Invalid callback")
  // body 不是终态依据；调用者必须再经 recordInfo 查真实任务。
  return taskId
}
