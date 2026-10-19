import { ApiError } from "./http";

/** 仅复用在飞请求，不缓存身份；超时后必须重新向服务端验证。 */
export function createSessionCheck<T>(probe: (signal: AbortSignal) => Promise<T>, timeoutMs = 15_000) {
  let pending: Promise<T> | null = null;
  return (): Promise<T> => {
    if (pending) return pending;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        const error = new Error("身份检查超时，请检查网络后重试");
        controller.abort(error);
        reject(error);
      }, timeoutMs);
    });
    pending = Promise.race([Promise.resolve().then(() => probe(controller.signal)), timeout])
      .finally(() => { clearTimeout(timer); pending = null; });
    return pending;
  };
}

export const sessionFailure = (error: unknown): "locked" | "retry" =>
  error instanceof ApiError && error.status === 401 ? "locked" : "retry";
