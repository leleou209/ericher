/**
 * HTTP 边界的输入闸门与失败响应。
 *
 * 放在 worker 入口之外，是为了能单独断言「客户端拿到的是人话、状态码是对的」，
 * 不必把整个 Worker 和 Durable Object 拉起来。
 */

/** 只在 HTTP 边界抛出：状态码与可公开的错误文案一起传递 */
export class HttpError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
    this.name = "HttpError";
  }
}

/**
 * 写接口一律用这个收 body：损坏 JSON、`null`、数组统一 400。
 *
 * 直接 `req.json()` 再解构会放行数组与 `null` —— 数组解构成一串 undefined，
 * 接口回 200 却真的写进了一条空记录；`null` 更糟，读 `body.x` 当场抛穿到平台层。
 * 字段本身仍归各路由与业务层校验，这里只管「是不是一个对象」。
 */
export async function readJsonObject(
  req: Request,
): Promise<Record<string, unknown>> {
  let value: unknown;
  try {
    value = await req.json();
  } catch {
    throw new HttpError(400, "请求格式错误");
  }
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new HttpError(400, "请求必须是 JSON 对象");
  return value as Record<string, unknown>;
}

/**
 * 把平台层的配额报错翻成人话。
 *
 * DO 免费层的「写入行数」是硬顶（10 万行/天），而且超了之后整个 DO 连**读**都会失败 ——
 * 这是平台行为，代码拦不住。但至少别把一行英文原文糊到面板上：
 * 那看起来像是我把什么东西弄坏了，实际上只是今天用完了，明早就回来。
 * 每天 00:00 UTC 重置，也就是北京时间早上 8 点。
 */
export function explain(e: unknown): string {
  const msg = (e as Error)?.message || String(e);
  if (/rows written in Durable Objects free tier/i.test(msg)) {
    // 别写成「读得到、只是记不下」—— 超限之后连读也会一起失败，那样说是在给自己找借口
    return "今天的记忆额度用完了（Cloudflare 免费层每天 10 万行写入，北京时间早上 8 点重置）。这会儿我整个人都动不了，连翻记忆都不行 —— 不是坏了，明早就回来。";
  }
  if (/rows read in Durable Objects free tier/i.test(msg)) {
    return "今天的读取额度用完了（Cloudflare 免费层每天 500 万行，北京时间早上 8 点重置）。明早就恢复。";
  }
  // 没认出来的错误不把原文直通用户：R2/DO 的报错里带着 key、内部状态，
  // 那是给排查看的日志不是给用户看的话 —— 原文进日志，用户只拿一句人话
  console.error(e);
  return "服务器开小差了，请稍后再试";
}

/** 统一的失败响应：HttpError 按原状态码回，其余先过一遍 explain 再落 500 */
export function fail(e: unknown): Response {
  if (e instanceof HttpError)
    return Response.json({ ok: false, error: e.message }, { status: e.status });
  return Response.json({ ok: false, error: explain(e) }, { status: 500 });
}
