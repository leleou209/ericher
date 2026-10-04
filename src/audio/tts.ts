// 语音合成：把 ericher 的文字变成声音。
//
// 为什么不再用浏览器自带的 speechSynthesis：
// 那是操作系统里十几年前塞进去的离线音色，念中文像地铁报站。
// 而声音是这个产品里最「人」的一处 —— 听感差，前面攒的所有人格都白搭。
//
// 用哪家读音服务不再写死在这里 —— 那份清单搬进了 tts_configs 表（见 ttsConfigs.ts），
// 管理员在面板上按顺序添配置，**顺序就是优先级**：念的时候从头找第一条
// key 配得上的用。这里只管「按配置把请求发出去」这一件事。
// 一条配置都用不上时返回原因，前端自然回退到浏览器自带音色。

// Env 是全局声明的（见 src/env.d.ts），不需要 import
// 每个供应商的地址分路都收在 src/mimo.ts 里，这里不重复一份
import { OWNER_AGENT } from "../auth";
import { mimoChatUrl } from "../mimo";
import type { TtsConfig, TtsProtocol } from "../agent/ttsConfigs";

const ZHIPU_TTS_URL = "https://open.bigmodel.cn/api/paas/v4/audio/speech";
const DOUBAO_TTS_URL =
  "https://openspeech.bytedance.com/api/v3/tts/unidirectional";

/**
 * 单次请求的文本上限。
 * 智谱硬上限是 1024 字符，这里留出余量：超了整句会被平台拒掉，
 * 而分段是前端按句切的，切点太长说明那段本身就不该一口气念。
 */
const TTS_CHUNK_MAX = 900;

export interface VoiceOption {
  /** tts_config 的 id；点名合成时就传它 */
  id: string;
  /** 给人看的名字 */
  label: string;
  provider: TtsProtocol;
  /** 一句话说明这条配置用哪家的嗓子 */
  desc: string;
  /** 这台机器现在用得上吗（key 配了才算） */
  available: boolean;
  /** 用不上的原因；空串表示能用 */
  why: string;
}

interface SynthResult {
  bytes: ArrayBuffer;
  mime: string;
}

/**
 * 一次合成的结果，念不成时也带着「为什么」。
 *
 * 为什么要把原因捎回来：以前失败只留一行 console.warn，于是
 * 「这台机器没配 key」和「key 配了但供应商当场拒了」在界面上长得一模一样 ——
 * 都是「云端没出声」。用户只会一直听到浏览器那个难听的嗓子，
 * 却拿不到任何线索指向真正的原因，只能靠猜。
 */
type SynthOutcome =
  ({ ok: true } & SynthResult) | { ok: false; why: string };

/** 从 env 里按变量名取 key；不是字符串一律当没配 */
function envKey(env: Env, name: string): string {
  const v = (env as unknown as Record<string, unknown>)[name || ""];
  return typeof v === "string" ? v : "";
}

/** 这条配置在这台机器上用得上吗：keySecret 点名的钥匙真的得在这 */
function configReady(env: Env, cfg: TtsConfig): boolean {
  return !!envKey(env, cfg.keySecret);
}

/**
 * tts_configs 表在主人那间，Worker 这边隔着 DO 读。
 * 缓存 30 秒：合成是按句来的，一句话几十次请求都打得到这份清单，
 * 而配置改一次用很久 —— 面板上说明生效延迟，比每句多一跳往返划算。
 */
let ttsCache: { at: number; configs: TtsConfig[] } | null = null;
const TTS_CACHE_MS = 30_000;

async function loadTtsConfigs(env: Env): Promise<TtsConfig[]> {
  if (ttsCache && Date.now() - ttsCache.at < TTS_CACHE_MS)
    return ttsCache.configs;
  try {
    const owner = env.COWORK_AGENT.get(
      env.COWORK_AGENT.idFromName(OWNER_AGENT),
    );
    const configs = (await owner.ttsConfigs()) || [];
    ttsCache = { at: Date.now(), configs };
    return configs;
  } catch {
    // 主人那间没醒：这轮按没配置过处理（返回空不缓存 —— 下一句说不定就醒了）
    return [];
  }
}

/**
 * 全部读音配置，外加每一条现在能不能用。
 *
 * 为什么不把用不上的直接滤掉：滤掉之后，配好的那几条在界面上
 * 等于「从来没存在过」，用户只看到一个空列表，却看不到任何原因。
 * 把它们列出来、标灰、写明缺哪把钥匙 —— 才是诚实的做法，
 * 而且这正好是「想要好听的声音该做什么」的操作指引。
 */
export async function ttsOptions(env: Env): Promise<VoiceOption[]> {
  return (await loadTtsConfigs(env)).map((c) => {
    const ok = configReady(env, c);
    return {
      id: c.id,
      label: c.name,
      provider: c.protocol,
      desc: c.voice ? `音色 ${c.voice}` : "默认音色",
      available: ok,
      why: ok ? "" : `这台机器没配 ${c.keySecret}`,
    };
  });
}

/** 这台机器能不能云端发声（前端据此决定要不要回退到自带音色） */
export async function canSynthesize(env: Env): Promise<boolean> {
  return (await loadTtsConfigs(env)).some((c) => configReady(env, c));
}

/**
 * 挑一条配置：他点名的那条优先，点名那条用不上（或没点名）就按
 * created 序退到第一条 key 配得上的。换一条念，比干脆不发声好。
 * 返回 null 表示这台机器一条都用不了。
 */
async function pickTtsConfig(
  env: Env,
  voiceId: string,
): Promise<TtsConfig | null> {
  const configs = await loadTtsConfigs(env);
  if (!configs.length) return null;
  const want = configs.find((c) => c.id === voiceId && configReady(env, c));
  return want || configs.find((c) => configReady(env, c)) || null;
}

/** 这条配置实际会用的音色。配置没写音色就退到各家的默认嗓子。 */
function voiceFor(env: Env, cfg: TtsConfig): string {
  const v = cfg.voice.trim();
  if (v) return v;
  // 豆包允许多配一副默认嗓子（DOUBAO_TTS_SPEAKER），再没有就交给服务端默认
  if (cfg.protocol === "doubao") return (env.DOUBAO_TTS_SPEAKER || "").trim();
  if (cfg.protocol === "glm-speech") return "tongtong";
  return "冰糖";
}

/**
 * 现在实际会用哪一副嗓子。
 *
 * 「我没选」也是一种选择 —— 界面得说得出这个默认到底是哪一副。
 * 否则设置页摆的是一列平等的选项，用户根本不知道此刻在听谁，
 * 还得靠回头去猜「默认的那一副」指的是哪一行。
 * 传空串就是问：什么都不选的话，你会用谁。
 */
export async function effectiveVoice(
  env: Env,
  voiceId: string,
): Promise<string> {
  const cfg = await pickTtsConfig(env, voiceId);
  return cfg ? voiceFor(env, cfg) : "";
}

/**
 * 念一段。text 由调用方切好（见 TTS_CHUNK_MAX）。
 * 念不成时返回原因，而不是抛错 ——「换不了嗓子」不该让整个请求 500。
 */
export async function synthesize(
  env: Env,
  text: string,
  voiceId: string,
): Promise<SynthOutcome> {
  const say = text.trim().slice(0, TTS_CHUNK_MAX);
  if (!say) return { ok: false, why: "这段没剩下可念的字" };
  const cfg = await pickTtsConfig(env, voiceId);
  if (!cfg)
    return {
      ok: false,
      why: "这台机器还没配读音服务（管理员面板 → 读音配置）",
    };

  try {
    const r =
      cfg.protocol === "mimo-chat"
        ? await synthMimo(env, cfg, say)
        : cfg.protocol === "doubao"
          ? await synthDoubao(env, cfg, say)
          : await synthZhipu(env, cfg, say);
    return { ok: true, ...r };
  } catch (e) {
    // 这里抛出来的信息已经是人话了（见 upstream），直接带给调用方
    const why = (e as Error).message;
    return { ok: false, why };
  }
}

/**
 * 供应商拒了这次合成时，把它的原文翻成一句人话。
 *
 * 为什么不把原文直接透出去：那是给开发者看的 JSON（错误码、英文字段名），
 * 摆在界面上只会让人更糊涂。而用户真正能采取的动作只有那么几个 ——
 * 换 key、充值、开通服务。所以只留下「该做什么」，原文留给日志。
 */
const UPSTREAM_HINT: Record<number, string> = {
  401: "key 不对，或者这项服务还没开通",
  403: "key 不对，或者这项服务还没开通",
  404: "说找不到这个模型，可能还没开通",
};

async function upstream(who: string, r: Response): Promise<Error> {
  const raw = (await r.text().catch(() => "")).slice(0, 300);
  console.warn(`[tts] ${who} 回了 ${r.status}：${raw}`);
  if (r.status === 429) {
    // 429 有两种：账户没钱了，或者这一会儿被限流。前者只能去充值，后者等一下就好 ——
    // 混成一句「请求太频繁」会让人白等一整天。
    const broke = /余额|balance|quota|resource pack|1113/i.test(raw);
    return new Error(
      broke
        ? `${who}账户余额不足，得先充值`
        : `${who}这会儿在限流，过一会儿再试`,
    );
  }
  return new Error(`${who}${UPSTREAM_HINT[r.status] || `回了 ${r.status}`}`);
}

// ── 小米 MiMo TTS（mimo-chat）─────────────────────────

/**
 * 让 MiMo 用什么口气念。
 *
 * 这是这家接口最好的地方：不用调 rate/pitch 那些参数，写一句话就行。
 * 而这句话基本决定了「她听起来像不像一个人」—— 播报腔是这个产品最不要的东西，
 * 所以默认写「像跟熟人聊天」。配置里的 style 有值就听配置的。
 */
const MIMO_STYLE =
  "用自然、温和、像跟熟人聊天的语气念。语速中等偏慢，句尾放松，不要念成新闻播报。";

/** url / model / voice / style 全部来自配置，空了才退到各自的默认值 */
async function synthMimo(
  env: Env,
  cfg: TtsConfig,
  text: string,
): Promise<SynthResult> {
  const url = cfg.baseUrl.trim() || mimoChatUrl(env);
  const r = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "api-key": envKey(env, cfg.keySecret),
    },
    body: JSON.stringify({
      model: cfg.model.trim() || "mimo-v2.5-tts",
      messages: [
        { role: "user", content: cfg.style.trim() || MIMO_STYLE },
        { role: "assistant", content: text },
      ],
      // mp3 而不是 wav：音频是塞在 JSON 里以 base64 回来的，wav 一分钟就上兆，
      // 念一段长回答能把响应撑到十几兆 —— 前端每句都要等这么久。
      audio: { format: "mp3", voice: voiceFor(env, cfg) },
    }),
  });
  if (!r.ok) throw await upstream("MiMo", r);

  const j = (await r.json()) as {
    choices?: { message?: { audio?: { data?: unknown } } }[];
  };
  const b64 = j.choices?.[0]?.message?.audio?.data;
  if (typeof b64 !== "string" || !b64) throw new Error("MiMo 没回音频数据");
  return { bytes: b64ToBytes(b64).buffer as ArrayBuffer, mime: "audio/mpeg" };
}

// ── 智谱 GLM-TTS（glm-speech）─────────────────────────

async function synthZhipu(
  env: Env,
  cfg: TtsConfig,
  text: string,
): Promise<SynthResult> {
  const r = await fetch(cfg.baseUrl.trim() || ZHIPU_TTS_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: "Bearer " + envKey(env, cfg.keySecret),
    },
    body: JSON.stringify({
      model: cfg.model.trim() || "glm-tts",
      input: text,
      voice: voiceFor(env, cfg),
      // 默认是 pcm，浏览器放不了；wav 才是能直接丢给 <audio> 的
      response_format: "wav",
      speed: 1.0,
    }),
  });
  if (!r.ok) throw await upstream("智谱", r);
  const bytes = await r.arrayBuffer();
  if (!bytes.byteLength) throw new Error("智谱回了个空音频");
  return { bytes, mime: "audio/wav" };
}

// ── 豆包 Seed-TTS 2.0（doubao）────────────────────────

function uuid(): string {
  return crypto.randomUUID();
}

/**
 * 豆包走的是「单向流式 HTTP」：一次把文本发过去，音频分块流回来。
 *
 * 返回的是一串换行的 JSON，每行带一小段 base64 音频，这里拼回完整文件再交给前端 ——
 * 不做真流式转发，是因为前端还要按句排队播放，多一层透传只会让链路更难查。
 *
 * 配置里的 model 字段对应资源 ID（X-Api-Resource-Id）；voice 是 speaker，
 * 空了先退 DOUBAO_TTS_SPEAKER，再没有就交给服务端默认嗓子。
 */
async function synthDoubao(
  env: Env,
  cfg: TtsConfig,
  text: string,
): Promise<SynthResult> {
  const speaker = voiceFor(env, cfg);
  const r = await fetch(cfg.baseUrl.trim() || DOUBAO_TTS_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Api-Key": envKey(env, cfg.keySecret),
      "X-Api-Resource-Id": cfg.model.trim() || "seed-tts-2.0",
      "X-Api-Request-Id": uuid(),
    },
    body: JSON.stringify({
      req_params: {
        text,
        // 没指定 speaker 时交给服务端默认 —— 硬塞一个空串反而会被当场拒掉
        ...(speaker ? { speaker } : {}),
        audio_params: { format: "mp3", sample_rate: 24000, speech_rate: 0 },
      },
    }),
  });
  if (!r.ok) throw await upstream("豆包", r);

  // 先整段收下来再判断形态：先按文本读会毁掉二进制，
  // 而这条接口在不同版本上既可能回 JSON 分块、也可能直接回音频字节。
  const raw = await r.arrayBuffer();
  if (!raw.byteLength) throw new Error("豆包回了个空音频");

  const parts: Uint8Array[] = [];
  let sawJson = false;
  for (const line of new TextDecoder().decode(raw).split("\n")) {
    const s = line.trim();
    if (!s) continue;
    let obj: { data?: unknown; code?: unknown; message?: unknown };
    try {
      obj = JSON.parse(s) as typeof obj;
    } catch {
      continue;
    }
    sawJson = true;
    if (typeof obj.code === "number" && obj.code !== 0) {
      throw new Error(
        `code ${obj.code}：${String(obj.message || "").slice(0, 200)}`,
      );
    }
    if (typeof obj.data === "string" && obj.data)
      parts.push(b64ToBytes(obj.data));
  }

  // 一行 JSON 都没有 —— 它这次直接回的就是音频本身
  if (!sawJson) return { bytes: raw, mime: "audio/mpeg" };

  const total = parts.reduce((n, p) => n + p.byteLength, 0);
  if (!total) throw new Error("没有拿到音频数据");
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.byteLength;
  }
  return { bytes: out.buffer, mime: "audio/mpeg" };
}

function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
