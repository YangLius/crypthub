/** API 客户端：同源 Cookie 会话；统一错误处理。 */

export class ApiError extends Error {
  status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

async function handle<T>(resp: Response): Promise<T> {
  if (resp.ok) {
    const ct = resp.headers.get('content-type') ?? ''
    return (ct.includes('application/json') ? await resp.json() : await resp.text()) as T
  }
  let msg = `HTTP ${resp.status}`
  try {
    const body = await resp.json()
    if (typeof (body as { detail?: unknown })?.detail === 'string') msg = (body as { detail: string }).detail
    else msg = JSON.stringify(body).slice(0, 300)
  } catch { /* 保留默认消息 */ }
  throw new ApiError(resp.status, msg)
}

async function req<T>(method: string, path: string, body?: unknown, contentType?: string): Promise<T> {
  const init: RequestInit = {
    method,
    headers: contentType ? { 'Content-Type': contentType } : undefined,
    body: body === undefined ? undefined
      : contentType?.includes('json') ? JSON.stringify(body)
        : body as BodyInit,
    credentials: 'same-origin',
  }
  if (contentType?.includes('json')) init.headers = { 'Content-Type': 'application/json' }
  return handle<T>(await fetch(path, init))
}

export const api = {
  get: <T>(path: string) => req<T>('GET', path),
  post: <T>(path: string, body?: unknown) => req<T>('POST', path, body, 'application/json'),
  patch: <T>(path: string, body?: unknown) => req<T>('PATCH', path, body, 'application/json'),
  put: <T>(path: string, body?: unknown) => req<T>('PUT', path, body, 'application/json'),
  delete: <T>(path: string) => req<T>('DELETE', path),
  form: <T>(path: string, form: FormData) => req<T>('POST', path, form),
}
