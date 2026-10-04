// 把流「压粗」：相邻的流式增量合并成更少的事件，再交给平台。
//
// 为什么非做不可：DO 免费层每天只有 10 万行写入，而平台的「断线续传」是
// **一个流式事件 = 一行 SQLite**（@cloudflare/ai-chat 读我们返回的响应体，
// 逐条 `data:` 事件 parse 后落库，见 node_modules/@cloudflare/ai-chat/dist/index.js
// 里 _storeStreamChunk 的调用点），24 小时后清理时再删一遍 —— 而 DELETE 同样计入
// 「rows written」。一次带思考过程的长回答几千个 token 增量就是几千行，
// 几十条回答够把一天烧光，然后连读都失败（超限后整个 DO 都不干活）。
//
// 这里**不是**「不落库」：分片是截断恢复（基类 _getPartialStreamText）的数据源，
// 关掉它「长思考说到一半没了」的老毛病就回来了。所以只压条数 ——
// 合并出来的仍是合法事件（text-delta 本来就是「追加」语义），
// 落库、重放、前端累加三件事都不受影响，只是条数少了一个量级。
//
// 口径：text-delta / reasoning-delta 按 id 合并（tool-input-delta 默认不动，
// 它是 JSON 片段，合并没有收益上的必要，风险却更大）。带 providerMetadata 的
// 一律原样发 —— 那是引用/来源之类带位置的标注，攒进别的分片里会错位。

/** 攒多久就发一次（毫秒）。越小越顺滑、写入越多 */
const DEFAULT_WINDOW_MS = 120;
/** 攒够这么多字就发一次。防的是「窗口没到但已经攒了一大段」 */
const DEFAULT_MAX_CHARS = 400;

interface CoalesceOpts {
  windowMs?: number;
  maxChars?: number;
  /** 连 tool-input-delta 也合并（默认关） */
  mergeToolInput?: boolean;
}

type Chunk = Record<string, unknown>;

/** 这条事件能不能合并；能的话返回该往哪个字段上累加 */
function deltaField(ev: Chunk, mergeToolInput: boolean): string | null {
  // 带元数据的原样发：合并会把标注挂到错误的字上
  if (ev.providerMetadata != null) return null;
  if (ev.type === "text-delta" || ev.type === "reasoning-delta") {
    // 两种流形状都认：toUIMessageStream 走 text，readUIMessageStream 走 delta
    if (typeof ev.delta === "string") return "delta";
    if (typeof ev.text === "string") return "text";
    return null;
  }
  if (
    mergeToolInput &&
    ev.type === "tool-input-delta" &&
    typeof ev.inputTextDelta === "string"
  ) {
    return "inputTextDelta";
  }
  return null;
}

/** 合并的身份：同一条事件的同一段内容才算相邻（换 part 就得断开） */
function identityOf(ev: Chunk, field: string): string {
  const id = ev.type === "tool-input-delta" ? ev.toolCallId : ev.id;
  return `${String(ev.type)}:${field}:${String(id ?? "")}`;
}

/**
 * 把响应体里相邻的同一条增量事件攒成一条再发出去。
 *
 * 输入输出都是标准 SSE（`data: {json}\n\n`，结尾 `data: [DONE]`），
 * 所以平台与前端都照常解析；非增量的事件一律先 flush 再原样透传，顺序不乱。
 */
export function coalesceStream(
  res: Response,
  opts: CoalesceOpts = {},
): Response {
  const body = res.body;
  if (!body) return res;

  const windowMs = opts.windowMs ?? DEFAULT_WINDOW_MS;
  const maxChars = opts.maxChars ?? DEFAULT_MAX_CHARS;
  const mergeToolInput = opts.mergeToolInput ?? false;

  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  let out: TransformStreamDefaultController<Uint8Array> | null = null;
  /** 上一次读进来的半行（网络分片不保证按行切） */
  let rest = "";
  /** 正在攒的那一条，以及它属于谁、往哪个字段加 */
  let pending: Chunk | null = null;
  let pendingKey = "";
  let pendingField = "";
  let pendingText = "";
  let lastEmit = Date.now();
  let timer: ReturnType<typeof setTimeout> | null = null;
  /** 攒着的事件把它的「空行」也一起攒了：先放空行会把边界插到内容前面去 */
  let owedBlank = false;

  const emitLine = (line: string): void => {
    out?.enqueue(encoder.encode(line + "\n"));
    lastEmit = Date.now();
  };

  const emitEvent = (ev: Chunk): void => {
    emitLine("data: " + JSON.stringify(ev));
  };

  /** 把攒着的发出去。没攒东西就什么都不做 */
  const flush = (): void => {
    if (!pending) return;
    pending[pendingField] = pendingText;
    emitEvent(pending);
    pending = null;
    pendingKey = "";
    pendingField = "";
    pendingText = "";
    if (owedBlank) {
      owedBlank = false;
      emitLine("");
    }
  };

  const disarm = (): void => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
  };

  /**
   * 到点兜底发一次。
   * 为什么不能只靠「下一条事件来了再判断」：工具在跑的时候可能几十秒没有新分片，
   * 那半句话就会卡在缓冲里既不落库也不上屏。
   */
  const arm = (): void => {
    if (timer || !pending) return;
    timer = setTimeout(() => {
      timer = null;
      flush();
    }, windowMs);
  };

  const handleLine = (line: string): void => {
    if (!line.startsWith("data: ")) {
      // 空行是事件边界，原样透传；但正攒着事件时先跟着一起攒，别把边界插到内容前面
      if (pending && line === "") owedBlank = true;
      else emitLine(line);
      return;
    }
    const payload = line.slice(6);
    if (payload === "[DONE]") {
      // 先把攒着的发完，再收尾，否则最后几个字会排在结束标记后面
      flush();
      emitLine(line);
      return;
    }
    let ev: Chunk;
    try {
      ev = JSON.parse(payload) as Chunk;
    } catch {
      // 认不出来就照原样放过去：宁可多写一行，也不能把这一轮弄哑
      emitLine(line);
      return;
    }

    const field = deltaField(ev, mergeToolInput);
    if (!field) {
      flush();
      emitEvent(ev);
      return;
    }

    const key = identityOf(ev, field);
    const text = String(ev[field]);
    if (pending && key === pendingKey) {
      pendingText += text;
      if (pendingText.length >= maxChars || Date.now() - lastEmit >= windowMs)
        flush();
      else arm();
      return;
    }
    // 换了一条（另一个 part / 另一种事件）：先把上一条收掉，顺序才不乱
    flush();
    pending = ev;
    pendingKey = key;
    pendingField = field;
    pendingText = text;
    if (text.length >= maxChars) flush();
    else arm();
  };

  const coalesced = body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      start(controller) {
        out = controller;
      },
      transform(chunk, controller) {
        out = controller;
        const text = rest + decoder.decode(chunk, { stream: true });
        const lines = text.split("\n");
        // 最后一段可能还没收尾，留着跟下一次拼
        rest = lines.pop() ?? "";
        for (const line of lines) handleLine(line);
      },
      flush() {
        if (rest) {
          handleLine(rest);
          rest = "";
        }
        flush();
        disarm();
        out = null;
      },
      cancel() {
        // 流被取消（客户端断开、点停止、切场重连）时不会走 flush：已武装的
        // 定时器到点仍会 flush，而 controller 已经关了 —— enqueue 会直接抛。
        // 在这里停表、摘掉出口，emitLine 里的 `out?.` 就兜住了
        disarm();
        pending = null;
        out = null;
      },
    }),
  );

  return new Response(coalesced, {
    status: res.status,
    statusText: res.statusText,
    headers: res.headers,
  });
}
