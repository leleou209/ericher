// 语音：识别走浏览器本地 Web Speech API（不过服务器）；朗读优先云端 TTS，失败退回浏览器音色。
// Chrome / Edge 能识别，Firefox 不能 —— 不能识别时不显示麦克风按钮，免得按了没反应。

import { isTextUIPart, type UIMessage } from "ai";
import { api } from "./api";

type RecCtor = new () => unknown;

/** 附件块标记（与 src/agent/attach.ts 一致）；念之前摘掉，不念转录稿 */
const ATTACH_RE = /【附件：[\s\S]*?】(?:\n?<<<附件正文[\s\S]*?附件正文>>>)?/g;

/** 一条消息里的正文（跳过工具调用那些部件，也跳过附件正文）—— 念的是话，不是工具名 */
export function textOf(m: UIMessage): string {
  return m.parts
    .filter(isTextUIPart)
    .map((p) => p.text)
    .join("\n")
    .replace(ATTACH_RE, "")
    .trim();
}

interface RecognitionLike {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  start(): void;
  stop(): void;
  onresult: ((e: SpeechResultEvent) => void) | null;
  onend: (() => void) | null;
  onerror: ((e: { error?: string }) => void) | null;
}

interface SpeechResultEvent {
  resultIndex: number;
  results: ArrayLike<{ isFinal: boolean; 0: { transcript: string } }>;
}

function recCtor(): RecCtor | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as {
    SpeechRecognition?: RecCtor;
    webkitSpeechRecognition?: RecCtor;
  };
  return w.SpeechRecognition || w.webkitSpeechRecognition || null;
}

/** 这个浏览器认不认识语音识别 */
export function canDictate(): boolean {
  return !!recCtor();
}

export function canSpeak(): boolean {
  return typeof window !== "undefined" && "speechSynthesis" in window;
}

/**
 * 开始听。返回能停的把手；浏览器不支持返回 null。
 * 开 interimResults 是为了边说边出字 —— 否则要等整句结束，人会以为没听清。
 */
export function startDictation(opts: {
  onText: (text: string) => void;
  onEnd: () => void;
  onError: (msg: string) => void;
}): { stop: () => void } | null {
  const Ctor = recCtor();
  if (!Ctor) return null;

  const rec = new Ctor() as unknown as RecognitionLike;
  rec.lang = "zh-CN";
  rec.continuous = true;
  rec.interimResults = true;

  let done = "";
  rec.onresult = (e) => {
    let interim = "";
    for (let i = e.resultIndex; i < e.results.length; i++) {
      const r = e.results[i];
      if (r.isFinal) done += r[0].transcript;
      else interim += r[0].transcript;
    }
    opts.onText(done + interim);
  };
  rec.onerror = (e) => {
    const code = e?.error || "unknown";
    if (code === "not-allowed" || code === "service-not-allowed")
      opts.onError("麦克风没被允许，看一下浏览器的权限设置");
    else if (code === "no-speech") opts.onError("没听到声音，再说一次？");
    else if (code === "aborted")
      return; // 自己停的，不算错
    else opts.onError("语音识别出了点问题：" + code);
  };
  rec.onend = () => opts.onEnd();

  try {
    rec.start();
  } catch {
    // 已经在听了（连点两下会走到这），当无事发生
  }
  return { stop: () => rec.stop() };
}

/**
 * 念不出来的字符，只切三类：不可见字符（合成器会发出「滴」声）、emoji 与变体选择符、
 * 箭头/方块/圆点等装饰符号。用最小切除而非白名单：白名单会连正文一起吃掉。
 */
const UNSPEAKABLE =
  /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\u200B-\u200F\u2028\u2029\uFEFF\u{FE00}-\u{FE0F}\u{E000}-\u{F8FF}\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2190}-\u{21FF}\u{2B00}-\u{2BFF}\u{25A0}-\u{25FF}]/gu;

/**
 * 把 Markdown 剥成能念出来的话。
 * 不剥的话它会念「星号星号」「反引号」，听着像在报错，不像在说话。
 */
export function stripForSpeech(md: string): string {
  return md
    .replace(/```[\s\S]*?```/g, "。这里有一段代码，我就不念了。")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/^\s{0,3}#{1,6}\s*/gm, "")
    .replace(/^\s{0,3}>\s?/gm, "")
    .replace(/^\s{0,3}[-*+]\s+/gm, "")
    .replace(/^\s{0,3}\d+\.\s+/gm, "")
    .replace(/^\s*\|.*\|\s*$/gm, "") // 表格整行跳过：念表格等于念乱码
    .replace(/^\s*[-:|\s]+$/gm, "")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/(^|[^*])\*([^*]+)\*/g, "$1$2")
    .replace(/~~([^~]+)~~/g, "$1")
    .replace(UNSPEAKABLE, " ")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{2,}/g, "。")
    .replace(/\n/g, "，")
    .trim();
}

// ── 朗读 ──────────────────────────────────────────────
//
// 两条路：
//   1. 云端（/api/tts → 豆包或智谱）—— 好听，但要钱、要网络
//   2. 浏览器自带 speechSynthesis —— 难听，但离线也能出声
// 优先走 1，拿不到音频就静默退到 2。听感差一点，总比点下去没反应好。

/** 云端合成按句切，攒到这么多字就发一段。太短请求数暴涨，太长第一句要等很久。 */
const CHUNK_SOFT_MAX = 60;

/** 重的标点断句最自然：人换气也在这儿 */
const SENTENCE_END = /(?<=[。！？!?；;…])/;

/** 把要念的话按句切段：短段先发让声音早点出来，长句硬切免得整段等合成 */
function splitForSpeech(text: string): string[] {
  const say = stripForSpeech(text);
  if (!say) return [];
  const sentences = say
    .split(SENTENCE_END)
    .map((s) => s.trim())
    .filter(Boolean);

  const chunks: string[] = [];
  let buf = "";
  for (const s of sentences) {
    // 单句就超长（比如没标点的一长串）：只能硬切，否则整段发不过去
    if (s.length > CHUNK_SOFT_MAX) {
      if (buf) {
        chunks.push(buf);
        buf = "";
      }
      for (let i = 0; i < s.length; i += CHUNK_SOFT_MAX)
        chunks.push(s.slice(i, i + CHUNK_SOFT_MAX));
      continue;
    }
    if ((buf + s).length > CHUNK_SOFT_MAX) {
      chunks.push(buf);
      buf = s;
    } else buf += s;
  }
  if (buf) chunks.push(buf);
  return chunks;
}

/** 正在念的那条。stopSpeaking 靠它把声音掐掉 */
let stopCloud: (() => void) | null = null;

/**
 * 让正在 await 的那一段播放立刻收尾。
 * 没有它的话，掐断之后循环会一直吊在那句 await 上，onEnd 永远不触发。
 */
let cutPlay: (() => void) | null = null;

/**
 * 云端念。没念成时把原因一起回给调用方（第一段就没取到音频），由它决定怎么退。
 *
 * 为什么要预取下一段：等的本来就是这一段播完的时间，提前把请求发出去，
 * 段与段之间就不会有那一声尴尬的停顿。
 */
async function speakCloud(
  text: string,
  voice: string,
  onEnd?: () => void,
): Promise<CloudTry> {
  const chunks = splitForSpeech(text);
  if (!chunks.length) return { why: "这一段里没有能念的字" };

  let stopped = false;
  let audio: HTMLAudioElement | null = null;
  stopCloud = () => {
    stopped = true;
    audio?.pause();
    cutPlay?.();
  };

  /**
   * 收尾。end=false（马上换浏览器音色接手）时绝不能调 onEnd：
   * 会熄掉「正在念」，让按钮看着没在念、再点也不是停 —— 这 bug 让打断朗读失效过。
   */
  const cleanup = (end: boolean) => {
    stopCloud = null;
    cutPlay = null;
    if (end) onEnd?.();
  };

  let pending = api.tts(chunks[0], voice);
  for (let i = 0; i < chunks.length; i++) {
    const got = await pending;
    if (stopped) {
      cleanup(true);
      return {};
    }
    // 第一段就拿不到 —— 云端这条路不通，带上原因交给调用方退到浏览器音色
    if (!("blob" in got)) {
      if (i === 0) {
        cleanup(false);
        return { why: got.why };
      }
      break; // 中途断了：已经念了半句，就此收住比突然换嗓子好
    }
    // 下一段先发出去，本段播完时它多半已经到了
    if (i + 1 < chunks.length) pending = api.tts(chunks[i + 1], voice);
    await playBlob(got.blob, (a) => {
      audio = a;
    });
  }
  cleanup(true);
  return {};
}

/** 播一段音频，播完（或出错、或被掐掉）才 resolve */
function playBlob(
  blob: Blob,
  keep: (a: HTMLAudioElement) => void,
): Promise<void> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(blob);
    const a = new Audio(url);
    keep(a);
    let over = false;
    const done = () => {
      if (over) return;
      over = true;
      cutPlay = null;
      URL.revokeObjectURL(url);
      a.onended = null;
      a.onerror = null;
      resolve();
    };
    // pause() 不会触发 ended，所以掐断时得由 cutPlay 把这里叫醒
    cutPlay = done;
    a.onended = done;
    a.onerror = done;
    a.play().catch(done);
  });
}

// ── 浏览器自带音色（兜底）────────────────────────────

let cachedVoice: SpeechSynthesisVoice | null | undefined;

/** 延迟起播的定时器：停的时候要连它一起清掉，否则「停了又冒出一句」 */
let speakTimer: ReturnType<typeof setTimeout> | null = null;
/** 当前这条语音（还没开口的也算）。停过之后就不该再让它响 */
let liveUtter: SpeechSynthesisUtterance | null = null;

/**
 * 给嗓子打分，分高的先选：系统里两代 zh-CN 音色混装，随手挑容易挑中最难听的离线版。
 * 网络音色更好听，但要把文字发给微软/谷歌 —— 只在云端念不成时才用。
 */
function scoreVoice(v: SpeechSynthesisVoice): number {
  const name = v.name.toLowerCase();
  const lang = v.lang.replace("_", "-").toLowerCase();
  let s = 0;
  if (/natural|online/.test(name)) s += 100; // 神经网络音色，比离线那批好一大截
  if (name.includes("google")) s += 60; // Chrome 的网络音色，中文也明显好过系统自带
  if (lang.startsWith("zh-cn")) s += 20;
  if (lang.startsWith("zh")) s += 10;
  if (v.localService) s += 1; // 平手时偏向本机音色：断网也不会念到一半哑掉
  return s;
}

/**
 * 挑一个中文嗓子。
 * 系统里可能一个中文音色都没有，那就交给默认的 —— 至少能出声，只是口音怪。
 */
function pickVoice(): SpeechSynthesisVoice | null {
  if (cachedVoice !== undefined) return cachedVoice;
  const all = speechSynthesis.getVoices();
  if (!all.length) return null; // 还没加载好，这次先用默认，下次调用就有了
  const zh = all.filter((v) =>
    v.lang.replace("_", "-").toLowerCase().startsWith("zh"),
  );
  cachedVoice = zh.length
    ? zh.reduce((a, b) => (scoreVoice(b) > scoreVoice(a) ? b : a))
    : null;
  return cachedVoice;
}

/** 有些浏览器音色是异步加载的，加载完把缓存清掉重挑一次 */
if (canSpeak()) {
  speechSynthesis.addEventListener?.("voiceschanged", () => {
    cachedVoice = undefined;
  });
}

/**
 * 用系统音色念。返回 false = 这台机器念不了。
 * 延迟 60ms 才 speak：Chrome 里 cancel() 紧跟 speak() 有几率不出声，让出一帧就稳。
 */
function speakBrowser(text: string, onEnd?: () => void): boolean {
  if (!canSpeak()) return false;
  const say = stripForSpeech(text);
  if (!say) return false;

  speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(say);
  const v = pickVoice();
  if (v) u.voice = v;
  u.lang = v?.lang || "zh-CN";
  u.rate = 1.05;
  u.pitch = 1.02;
  const finish = () => {
    if (liveUtter === u) liveUtter = null;
    onEnd?.();
  };
  u.onend = finish;
  u.onerror = finish;
  liveUtter = u;
  speakTimer = setTimeout(() => {
    speakTimer = null;
    // 这 60ms 里可能已经被叫停了，那就不该再开口
    if (liveUtter !== u) return;
    speechSynthesis.speak(u);
  }, 60);
  return true;
}

/** 云端结果：why 为空 = 念成了；有 why 是一句可直接展示的人话 */
type CloudTry = { why?: string };

/** 这一次到底是谁念的。不是云端时，why 说明云端为什么没接上 */
type Spoken =
  | { by: "cloud" }
  | { by: "browser"; why: string }
  | { by: "none"; why: string };

export async function speak(
  text: string,
  voice: string,
  onEnd?: () => void,
): Promise<Spoken> {
  stopSpeaking();
  const cloud = await speakCloud(text, voice, onEnd);
  if (!cloud.why) return { by: "cloud" };
  return speakBrowser(text, onEnd)
    ? { by: "browser", why: cloud.why }
    : { by: "none", why: cloud.why };
}

export function stopSpeaking(): void {
  if (stopCloud) {
    stopCloud();
    stopCloud = null;
  }
  if (speakTimer) {
    clearTimeout(speakTimer);
    speakTimer = null;
  }
  liveUtter = null;
  if (canSpeak()) speechSynthesis.cancel();
}
