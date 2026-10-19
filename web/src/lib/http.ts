/** REST 传输层：统一处理登录失效、HTTP 错误和业务错误。 */
export class ApiError extends Error {
  constructor(message: string, public readonly status: number) {
    super(message);
    this.name = "ApiError";
  }
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function errorMessage(body: unknown, fallback: string): string {
  if (record(body)) {
    for (const key of ["error", "why"])
      if (typeof body[key] === "string" && body[key]) return body[key];
  }
  return fallback;
}

async function readBody(response: Response): Promise<unknown> {
  const text = await response.text();
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

export function assertApiSuccess<T>(body: unknown, fallback: string): T {
  if (record(body) && body.ok === false)
    throw new ApiError(errorMessage(body, fallback), 200);
  return body as T;
}

/** 可注入 fetch，测试传输行为无需启动 React 或 Cloudflare。 */
export function createHttpClient(fetcher: typeof fetch = (...args) => fetch(...args)) {
  let unauthorized: (() => void) | null = null;

  function notifyUnauthorized(path: string, response: Response) {
    // 登录失败表示口令错误；登卡也仍在门口，不触发会话过期处理。
    const pathname = path.split("?")[0];
    if (response.status === 401 && pathname !== "/api/auth" && pathname !== "/api/card/login")
      unauthorized?.();
  }

  async function response(path: string, init?: RequestInit): Promise<Response> {
    const result = await fetcher(path, init);
    notifyUnauthorized(path, result);
    if (!result.ok) {
      const body = await readBody(result);
      const fallback = result.status === 401
        ? "登录已过期，请重新验证"
        : `${result.status} ${result.statusText || "请求失败"}`;
      throw new ApiError(errorMessage(body, fallback), result.status);
    }
    return result;
  }

  async function request<T>(path: string, init?: RequestInit): Promise<T> {
    const result = await response(path, init);
    const body = await readBody(result);
    if (body === undefined)
      throw new ApiError("服务器响应格式错误，请稍后再试", result.status);
    if (record(body) && body.ok === false)
      throw new ApiError(errorMessage(body, "请求失败"), result.status);
    if (record(body) && body.ok === true && "data" in body) return body.data as T;
    return body as T;
  }

  return {
    request,
    response,
    setUnauthorizedHandler(fn: (() => void) | null) { unauthorized = fn; },
  };
}

export const json = (method: string, payload: unknown): RequestInit => ({
  method,
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(payload),
});

const client = createHttpClient();
export const request = client.request;
export const requestResponse = client.response;
export const setUnauthorizedHandler = client.setUnauthorizedHandler;
