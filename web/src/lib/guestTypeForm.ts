// 来客类型表单里的纯规则：必填校验、口令格怎么处理、列表行摘要。
//
// 为什么要外提：名册从「行内展开编辑」换成「列表 + 详情弹页」后，新增与编辑共用同一份
// 表单，「留空算不算改口令」「这一档现在开着什么」这类判断不能再散在 JSX 里 ——
// 改一句措辞就顺手碰坏边界的，正是这些东西。
// 这里只有规则：不碰接口、不碰 DOM，提交口径仍由面板走 lib/api。

import type { GuestType } from "./types";

/** 内置通用档的 id：口令就是 env 里的前台门禁口令，改不得也停不得 */
export const COMMON_TYPE_ID = "common";

/**
 * 弹页草稿。
 * 口令这格永远以空串起头：后端只存 SHA-256 摘要，摘要不可逆，没有「打开来看一眼」这条路。
 * active 不在这里 —— 停用/启用是动作，留在列表行右侧，不当表单字段。
 */
export interface GuestFormDraft {
  name: string;
  password: string;
  note: string;
}

export const blankGuestDraft = (): GuestFormDraft => ({
  name: "",
  password: "",
  note: "",
});

/** 编辑某一档 = 拍下这份快照；口令格仍是空的，那是「不改」不是「回填」 */
export const guestDraftOf = (t: GuestType): GuestFormDraft => ({
  name: t.name,
  password: "",
  note: t.note,
});

/** 缺项：field 让调用方知道该往哪一格上指，message 是可以直接给人看的一句话 */
export interface GuestFieldError {
  field: "name" | "password";
  message: string;
}

/**
 * 必填校验：返回缺的那几项（都填了就空数组），顺序就是表单里出现的顺序。
 * trim 后才判空 —— 「   」是手滑留下的空格，不是填过了。
 * 口令只在新增时必填：编辑时留空的意思是不改这一档的口令。
 */
export const guestMissingFields = (
  d: Pick<GuestFormDraft, "name" | "password">,
  isNew: boolean,
): GuestFieldError[] => {
  const checks: Array<{
    field: GuestFieldError["field"];
    value: string;
    message: string;
    required: boolean;
  }> = [
    {
      field: "name",
      value: d.name,
      message: "请填写这一档的名称",
      required: true,
    },
    {
      field: "password",
      value: d.password,
      message: "请设一个进门口令",
      required: isNew,
    },
  ];
  return checks
    .filter(({ value, required }) => required && !value.trim())
    .map(({ field, message }) => ({ field, message }));
};

/**
 * 口令格的两态：留空（或只有空格）= 不改，返回 undefined 让 PATCH 干脆不带这个字段；
 * 填了才 trim 成新口令。
 *
 * 为什么没有「清除」这一态：后端 updateGuestType 见空口令直接抛
 * 「来客类型的密码不能为空」—— 一档不能没有口令，不在这张表里假装支持。
 * 真不要这个口令了，只有删掉整档这一条路。
 */
export const guestPasswordValue = (raw: string): string | undefined => {
  const v = raw.trim();
  return v ? v : undefined;
};

/** 三项长期权益的界面用词，与「来客权限管理」页的开关同名同序 */
export const GUEST_CARD_PERMS: Array<{
  key: "permNotes" | "permFiles" | "permPublic";
  label: string;
}> = [
  { key: "permNotes", label: "记事本" },
  { key: "permFiles", label: "云盘上传" },
  { key: "permPublic", label: "公开内容" },
];

/**
 * 行摘要：一行看清这一档现在能干什么、能不能进门。
 * 顺序是「先看有没有坏，再看有什么」：停用标记排最前，接待说明排最后 ——
 * 说明是这行里最长的东西，窄屏该被省略号切掉的是它，不是工具件数。
 */
export const guestTypeSummary = (t: GuestType): string => {
  const parts: string[] = [];
  if (!t.active) parts.push("已停用");
  parts.push(
    t.id === COMMON_TYPE_ID
      ? "口令＝前台门禁口令"
      : "口令已设（只存摘要）",
  );
  parts.push(t.tools.length ? `对外工具 ${t.tools.length} 件` : "对外工具全关");
  const on = GUEST_CARD_PERMS.filter((p) => t[p.key]).map((p) => p.label);
  parts.push(on.length ? `长期权益 ${on.join("/")}` : "长期权益全关");
  if (t.note.trim()) parts.push(t.note.trim());
  return parts.join(" · ");
};
