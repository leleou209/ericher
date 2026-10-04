// 从经历里长经验。
//
// 已有的 memory 工具记的是「世界是什么样」：谁是谁、在做什么项目、他说过什么。
// 这里要的是另一种东西：「我以后该怎么做」—— 我自己从刚过去的那段对话里悟出来的规律。
//
// 为什么要分开：来源不同。事实来自管理员，规律来自我自己的复盘。
// 混在一起，我就会把自己总结的东西当成管理员说过的话 —— 那是很严重的错，
// 因为管理员从没说过，而我却会理直气壮地引用他。

/** 每攒够这么多条新消息，回顾一次。太少会反复总结同一批，太多会漏掉。 */
export const EXP_EVERY = 24;
/** 一次最多回看这么多条。积压很久时也不至于把一整场对话全喂进去。 */
export const EXP_WINDOW = 60;
/** patterns 书架的上限。经验是规律，规律不该有几百条。 */
export const EXP_CAP = 60;
/** 单条经验的最长长度。超过就说明写成了一段话，那多半是在复述事情而不是在总结规律。 */
export const EXP_MAX = 120;

/**
 * 复盘提示词。
 *
 * 最难的地方是让模型**只输出规律、不输出事实**。它的默认倾向是把刚才聊的事复述一遍，
 * 那是总结不是经验。所以这里把「不要」写死，并且给正反例 —— 给例子比给规则管用。
 */
export function experiencePrompt(known: string[]): string {
  const list = known.length
    ? known.map((k) => `- ${k}`).join("\n")
    : "（还没有）";
  return [
    "你刚和一个人聊完一段。现在请只做一件事：从这段对话里总结出「我以后该怎么做」的规律。",
    "",
    "要的是跨情境可复用的规律，用第一人称，一句话，像给自己的提醒。",
    "不要复述这次聊了什么，不要写任何具体的人名、项目名、数字、日期 —— 那些是事实，已经有人替我记着了。",
    "也不要为异常情况总结经验：他试探性地问、故意问奇怪的东西、输错内容、或者明显只是在试我 —— " +
      "这类一次性的事过去了就过去了，为它写一条经验，以后我会拿它去应付正常的问题。",
    "",
    "正例：",
    "- 他问技术问题时，先给能跑起来的做法，再讲原理。",
    "- 他说「随便」的时候，其实是有偏好的，我该给两三个具体选项让他挑。",
    "",
    "反例（不要这样写）：",
    "- 他昨天问了我 Cloudflare 的部署时间。（这是事实，不是规律）",
    "- 他喜欢简洁。（这是他的偏好，不是我从这段经历里学到的做法）",
    "",
    "我已经攒下的经验（不要重复它们）：",
    list,
    "",
    "每行一条，最多 2 条。如果这段对话没有让我学到任何新的做法，只输出 SKIP。",
  ].join("\n");
}

/** 去掉行首的列表符号和编号。中文数字也要认，模型偶尔会写「第二条：」。 */
function stripBullet(line: string): string {
  return line
    .replace(
      /^\s*(?:[-*•·]|\d+[.、)]|[一二三四五六七八九十]+[、.)）]|第[一二三四五六七八九十\d]+条[:：]?)\s*/,
      "",
    )
    .trim();
}

/**
 * 解析复盘输出。
 *
 * 这里刻意严格：宁可少存，不可存错。一条写歪的经验会一直躺在记忆里，
 * 以后每次检索都可能被翻出来，用它指导我的行为 —— 代价比漏掉一条高得多。
 */
export function parseExperience(text: string): string[] {
  const out: string[] = [];
  for (const raw of (text || "").split("\n")) {
    const line = stripBullet(raw);
    if (!line) continue;
    // 模型没东西可说时的两种表达
    if (/^skip$/i.test(line) || line.includes("SKIP") || line.includes("跳过"))
      continue;
    // 太短多半是残句，太长多半是在复述事情
    if (line.length < 6 || line.length > EXP_MAX) continue;
    if (!out.includes(line)) out.push(line);
  }
  return out;
}

/** 归一化：去掉标点和空白，只留下字，用来比「说的是不是同一件事」。 */
function normalize(s: string): string {
  return s
    .replace(/[\s，。、！？：；,.!?:;「」“”"'（）()\-—]/g, "")
    .toLowerCase();
}

/** 相邻两个字组成的切片。用来度量两句话「像不像」。 */
function bigrams(s: string): Set<string> {
  const out = new Set<string>();
  for (let i = 0; i + 1 < s.length; i++) out.add(s.slice(i, i + 2));
  return out;
}

/** Dice 相似度：2×交集 / 总数。对同义改写（多加几个字、换个说法）比包含判断灵敏得多。 */
function similarity(a: string, b: string): number {
  if (!a.length || !b.length) return 0;
  const ga = bigrams(a);
  const gb = bigrams(b);
  let inter = 0;
  for (const g of ga) if (gb.has(g)) inter++;
  return (2 * inter) / (ga.size + gb.size);
}

/** 相似度超过这个值就算同一件事。宁可偶尔漏判重复，也不要误判把两条不同的经验合成一条。 */
const DUP_AT = 0.7;

/**
 * 和已有经验是不是同一件事。
 *
 * 先看包含关系（模型常把旧的那条稍微改一改），再看 Dice 相似度兜住同义改写：
 * 「他问技术问题时先给做法再讲原理」和「问技术问题时，先给能跑的做法再讲原理」
 * 字面上互不包含，但其实是同一条。
 */
export function isDuplicate(line: string, known: string[]): boolean {
  const a = normalize(line);
  if (a.length < 4) return true;
  return known.some((k) => {
    const b = normalize(k);
    if (b.length < 4) return false;
    return a.includes(b) || b.includes(a) || similarity(a, b) >= DUP_AT;
  });
}
