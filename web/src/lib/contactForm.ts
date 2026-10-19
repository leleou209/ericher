// 人脉面板与弹页里的纯规则：必填校验、来客归类、人物行摘要、提交载荷。
//
// 为什么要外提：联系人就是「按人翻记忆」这一条路，人物名、条数、来客前缀的判断
// 原先都写死在 JSX 里。是来客还是本人、姓名长了会不会被截、哪些格非填不可 ——
// 这些边界抽出来才测得住。标签那一格的规矩和记忆面板完全同源，直接复用 memoryForm。
//
// 字段清单以 GET /api/persons 与 POST /api/memory 为准：前者只回 person + n，
// 所以摘要里除了条数不该有别的数字；后者才收 content / shelf / tags / person / volatility。

import { parseTags, type MemoryVolatility } from "./memoryForm";

/** 记一条关于某人的事：人是这一条的户口，事是正文 */
export interface ContactDraft {
  person: string;
  content: string;
  tags: string;
  volatility: MemoryVolatility;
}

/** 弹页里出现顺序就是缺项提示的顺序 */
export type ContactRequiredField = "person" | "content";

export interface ContactFieldError {
  field: ContactRequiredField;
  message: string;
}

/** 后端 insertMemory 把 person 截到 40 字（src/agent/memory.ts）：长了会被悄悄改小 */
export const MAX_PERSON_CHARS = 40;

/** 来客在记忆里的户口前缀：后端按「来客·X」写进来，前端靠它把一拨拨人拢到一起看 */
export const GUEST_PREFIX = "来客·";

/**
 * 必填校验：返回缺的那几项（填齐了就空数组），顺序就是弹页里两格的先后。
 * trim 后才判空 —— 空格不是名字，也不是要记住的事。
 */
export const contactMissingFields = (
  d: Pick<ContactDraft, "person" | "content">,
): ContactFieldError[] => {
  const checks: Array<{
    field: ContactRequiredField;
    value: string;
    message: string;
  }> = [
    { field: "person", value: d.person, message: "请填写人物姓名或称呼" },
    { field: "content", value: d.content, message: "请写下要记住的事" },
  ];
  return checks
    .filter(({ value }) => !value.trim())
    .map(({ field, message }) => ({ field, message }));
};

/** 姓名过长只做提示、不拦保存：截到 40 字本来就是后端的规矩 */
export const personNameTooLong = (raw: string): boolean =>
  raw.trim().length > MAX_PERSON_CHARS;

/** 这个户口是不是来客 */
export const isGuestPerson = (person: string): boolean =>
  (person || "").startsWith(GUEST_PREFIX);

/** 名单里有没有来客：没有就不必摆出那个开关 */
export const hasGuestPerson = (
  people: Array<{ person: string }>,
): boolean => people.some((p) => isGuestPerson(p.person));

/** 提交前折成请求体：名字与正文都按后端口径 trim，标签复用记忆面板那套切法 */
export const contactPayloadOf = (d: ContactDraft) => ({
  content: d.content.trim(),
  person: d.person.trim(),
  tags: parseTags(d.tags),
  volatility: d.volatility,
});

/** 人物行摘要：/api/persons 只回条数，所以这里也只有条数，别编出第二个数字 */
export const personSummary = (n: number): string =>
  n > 0 ? `${n} 条记忆` : "还没记下关于他的事";
