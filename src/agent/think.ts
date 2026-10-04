/**
 * 「她正在想什么」。
 *
 * 开口之前那一段是长的：深想一次几十秒，中间还要查资料、读网页、画图。
 * 主人那边看得到她真正的内心独白；来客那边整段推理是不给他看的 ——
 * 于是屏幕上只剩一个空气泡和一闪一闪的光标。等的人分不清「她在琢磨」和「她卡了」，
 * 而这两件事在他那边长得一模一样。
 *
 * 所以这里做的不是把真思考摊给谁看，是让等在外面的人知道她还在动、动到哪一步：
 * 每隔几秒把这一轮真实的动静（内心独白 + 已经跑过的工具）交给维护模型，
 * 让它翻成一句第一人称的中文。翻出来的那一句是能见人的 —— 不许复述任何具体内容，
 * 只说她在做什么。真推理一个字都不出这个模块。
 *
 * 三件事都刻意做得小气：三秒内才开口的不出声（快答不该闪一下「她正在想」）、
 * 她已经在说话且手上没在忙就不再翻（外面看得见正文，这一次调用是白花的）、
 * 一轮最多翻几句（这是维护模型上的花费闸）。
 */

type ThinkerDeps = {
  /** 叫维护模型翻一句。翻不出来（超时、报错、没配模型）返回空串就行 */
  ask: (system: string, user: string) => Promise<string>;
  /** 有一句新的了，推给这个房间所有连着的人 */
  emit: (turn: number, line: string) => void;
};

/** 第一次出声要等这么久。三秒内能答完的话，人不该看见「她正在想」——那只会闪一下 */
export const FIRST_AFTER = 3_500;
/** 之后每隔这么久翻一句 */
export const EVERY = 9_000;
/** 一轮最多翻几句。这也是花在维护模型上的次数上限 */
export const MOST_LINES = 6;
/** 一轮最多看几次表。空转（她已经在说话）也算一次，长回答才不至于跑到天荒地老 */
export const MOST_TICKS = 12;
/** 喂给维护模型的内心独白取最近这一段 */
const THINK_KEEP = 1_600;

/** 在跑的那一步用「…」记，跑完的用「✓」——维护模型靠它知道她这一刻忙到哪了 */
type Step = { name: string; done: boolean };

/**
 * 收拾成一行能直接摆上界面的字。
 * 模型偶尔会带引号、编号、换行，或者先给一段解释再给正文 —— 只取第一行有用的。
 */
export function cleanLine(raw: string): string {
  const first =
    (raw || "")
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean)[0] || "";
  const bare = first
    .replace(/^["'“”‘’「『]+|["'“”‘’」』]+$/g, "")
    .replace(/^[-*·•\d.、)）]+\s*/, "")
    .trim();
  return bare.length > 40 ? bare.slice(0, 40) + "…" : bare;
}

const THINK_SYSTEM =
  "你是 ericher。此刻你正在回答一句话，还没开口，屏幕那头的人只看到一个转圈的空气泡，" +
  "等得有点心里没底。以下是你这一轮真实的内心活动和已经做过的事。\n" +
  "用一句不超过 20 个字的中文、第一人称，说出你此刻正在做什么，像自言自语那样自然。\n" +
  "规矩：\n" +
  "1. 不复述任何具体内容 —— 人名、时间、数字、他说过的原话、私事，一个字都不许带出来；只说你在做什么、卡在哪一步。\n" +
  "2. 不许出现「用户」「系统」「推理」「思考过程」「正在处理」这类词。\n" +
  "3. 不要解释你在遵守什么规矩，不要面面俱到，点到为止。\n" +
  "只输出这一句话。";

export class Thinker {
  /**
   * 轮次号。客户端靠它认出「这是新一轮」还是「上一轮的尾巴」。
   *
   * 用时间戳而不是自增：这个号是跨进程存在的 —— 实例被驱逐、被重新部署之后
   * 内存里的字段从零开始，而客户端手上还攥着上一轮的号。自增的话重启后头几轮
   * 报出来的号比它手上的小，会被当成旧尾巴丢掉 —— 恰好在最需要出声的时候不出声。
   * 时间戳只往上走，重启也不倒。
   */
  private seq = 0;
  /** 这一轮还在不在。收尾之后 loop 所见即停 */
  private live = false;
  /** 她已经开口说过字没有 */
  private spoken = false;
  /** 最近这段内心独白 */
  private thinking = "";
  private steps: Step[] = [];
  private lines = 0;
  private misses = 0;
  private said = "";
  private at = 0;
  /** 收尾时把还在睡的定时器一并叫醒，别让它们空等到天亮 */
  private sleepers = new Set<() => void>();

  constructor(private deps: ThinkerDeps) {}

  /**
   * 开一轮，返回这一轮的号 —— 原样交给 end，上一轮的尾巴靠它认出来。
   * 调用方拿这个号去 waitUntil(run(id))。
   */
  begin(said: string): number {
    const now = Date.now();
    this.seq = now > this.seq ? now : this.seq + 1;
    this.live = true;
    this.spoken = false;
    this.thinking = "";
    this.steps = [];
    this.lines = 0;
    this.misses = 0;
    this.said = said.slice(0, 300);
    this.at = Date.now();
    return this.seq;
  }

  /** 一轮结束了（答完、被打断、出错都算） */
  end(): void {
    this.live = false;
    for (const wake of [...this.sleepers]) wake();
  }

  /**
   * 这一轮的流里过来的每个 chunk。
   *
   * 必须立刻返回：AI SDK 会停在它这儿等 —— 里面哪怕放一次模型调用，
   * 主体回答就会跟着卡住，那就本末倒置了。这里只记，不说话。
   */
  observe(chunk: { type: string; text?: unknown; toolName?: unknown }): void {
    if (!this.live) return;
    if (chunk.type === "reasoning-delta") {
      if (typeof chunk.text === "string") {
        this.thinking = (this.thinking + chunk.text).slice(-THINK_KEEP);
      }
      return;
    }
    if (chunk.type === "text-delta") {
      this.spoken = true;
      return;
    }
    const name = typeof chunk.toolName === "string" ? chunk.toolName : "";
    if (!name) return;
    if (chunk.type === "tool-call") {
      this.steps.push({ name, done: false });
      // 只留最近几步：前面做过什么，提示词里点一句就够，不必背着全过程
      if (this.steps.length > 6) this.steps = this.steps.slice(-6);
      return;
    }
    if (chunk.type === "tool-result") {
      const step = this.steps.find((s) => !s.done && s.name === name);
      if (step) step.done = true;
    }
  }

  /** 一轮的节拍器。挂在 waitUntil 上，自己醒来、自己收工 */
  async run(seq: number): Promise<void> {
    for (let i = 0; i < MOST_TICKS; i++) {
      await this.wait(i === 0 ? FIRST_AFTER : EVERY);
      if (this.over(seq)) return;
      if (this.lines >= MOST_LINES) return;
      // 她已经在说话、手上也没在忙 —— 外面看得见正文，这一趟不用花模型
      if (this.quiet()) continue;
      const line = await this.say();
      if (!line) {
        // 翻不出来多半是这一次超时了，再给一次机会；连着两次不行就这一轮算了
        this.misses += 1;
        if (this.misses >= 2) return;
        continue;
      }
      if (this.over(seq)) return;
      // 翻的这几秒里她开口了，这句已经晚了 —— 推出去只会压在正文上面
      if (this.quiet()) continue;
      this.lines += 1;
      this.deps.emit(seq, line);
    }
  }

  /** 这一轮还在不在、号还对不对 */
  private over(seq: number): boolean {
    return !this.live || this.seq !== seq;
  }

  /** 外面已经看得见她的话，且她手上没在忙 */
  private quiet(): boolean {
    return this.spoken && !this.steps.some((s) => !s.done);
  }

  private async say(): Promise<string> {
    return cleanLine(await this.deps.ask(THINK_SYSTEM, this.brief()));
  }

  /** 交给维护模型的那点材料：他说了什么、过了多久、已经动了哪些手、她心里在想什么 */
  private brief(): string {
    const sec = Math.round((Date.now() - this.at) / 1000);
    const steps = this.steps.length
      ? "已经做的事：" +
        this.steps.map((s) => `${s.done ? "✓" : "…"}${s.name}`).join(" ") +
        "（…是还没出结果的）"
      : "还没动手，只是在想。";
    return (
      `他对我说的是：${this.said || "（没留下文字）"}\n` +
      `从开口到现在过了 ${sec} 秒。\n` +
      steps +
      "\n我的内心活动（原文，只有你能看到，不要复述）：\n" +
      (this.thinking || "（还没出声，正在读他的话）")
    );
  }

  /**
   * 睡一会儿，但收尾能把它提前叫醒。
   * 不叫醒也行（醒来一看 live 已经是 false，直接退），代价是白挂一个定时器；
   * 一轮一句都没翻就又多了个睡着的定时器，堆着不好看。
   */
  private wait(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        this.sleepers.delete(done);
        resolve();
      };
      const timer = setTimeout(done, ms);
      this.sleepers.add(done);
    });
  }
}
