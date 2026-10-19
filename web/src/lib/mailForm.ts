// 邮件设置表单的纯规则：草稿/提交口径、必填校验、端口与加密组合、secret 变量名、
// 默认收件地址表、开关措辞、行摘要。外提是因为测试环境没有 jsdom，写进 JSX 就测不住；
// 这里不碰接口与 DOM，提交仍由面板走 lib/api。

import { looksLikeRawKey } from "./modelCatalogForm";
import type {
  MailConfigPatchFull,
  MailConfigViewFull,
  MailLastSend,
} from "./types";

/** 界面收住的每日上限：再大基本是多打了几个 0，放过去每天的发送账就白记了 */
export const MAX_DAILY_CAP = 1000;

/**
 * 默认收件地址表上限：这张表是「没点名寄给谁时」的去处，
 * 二十个够用（后端也收这么多）。
 */
export const MAX_TO_ADDRESSES = 20;

/** 隐式 TLS 的标准门（契约里 secure=true 说的就是这两扇） */
export const IMPLICIT_TLS_PORTS = [465, 997];

/** 明文起步 + STARTTLS 的标准门（契约里 secure=false 说的就是它） */
export const STARTTLS_PORT = 587;

/**
 * 平台禁止出站的端口：后端直接 400，这里当场拦住 ——
 * 别让人按完保存才知道白填一场。
 */
export const BLOCKED_PORTS = [25];

export const blockedPortMessage = (n: number): string =>
  `${n} 端口这台机器出不去（平台禁止出站）：改 465 或 587`;

/** 加密方式 → 界面上那三个字：行摘要与提示共用，不在两处各写一份措辞 */
export const secureLabel = (secure: boolean): string =>
  secure ? "隐式TLS" : "STARTTLS";

/**
 * 弹页草稿：端口与每日上限是字符串 —— 没敲完的「58」也是合法编辑状态，
 * 塞成数字会吞掉正在打的字。`to` 是地址表文本（一行一个），提交前才拼回。
 * 草稿里永远没有口令：凭据只住 keySecret 所指的 Worker secret。
 */
export interface MailDraft {
  enabled: boolean;
  hostname: string;
  port: string;
  secure: boolean;
  username: string;
  keySecret: string;
  from: string;
  /** 默认收件地址表文本：一行一个地址 */
  to: string;
  dailyCap: string;
  /** 提醒 / 盯梢到点时另寄一份邮件副本 */
  sayMail: boolean;
  /** 收信落库：开着外面的信才进收件箱 */
  inboxEnabled: boolean;
}

/** 空白草稿：只用来在配置读回来之前占住这份草稿，一格也没填、两个开关都关着 */
export const blankMailDraft = (): MailDraft => ({
  enabled: false,
  hostname: "",
  port: "",
  secure: true,
  username: "",
  keySecret: "",
  from: "",
  to: "",
  dailyCap: "",
  sayMail: false,
  inboxEnabled: false,
});

/** 视图 → 草稿：逐格抄，两个数字格回写成界面口径（字符串），地址表规整成一行一个 */
export const mailDraftOf = (v: MailConfigViewFull): MailDraft => ({
  enabled: v.enabled,
  hostname: v.hostname,
  port: String(v.port),
  secure: v.secure,
  username: v.username,
  keySecret: v.keySecret,
  from: v.from,
  to: joinAddressTable(addressTableOf(v)),
  dailyCap: String(v.dailyCap),
  sayMail: v.sayMail ?? false,
  inboxEnabled: v.inboxEnabled ?? false,
});

/** 端口：1–65535 的整数才算数，其余（空、小数、超界、不像数字）一律 undefined */
export const parsePort = (raw: string): number | undefined => {
  const n = Number(raw.trim());
  return Number.isInteger(n) && n >= 1 && n <= 65535 ? n : undefined;
};

/**
 * 每日上限：只认 0 到 MAX_DAILY_CAP；小数四舍五入（后端只收整数）。
 * 超界不悄悄收在上限上 —— 后端本来就 400，改写成人没填的数比报错更糟。
 */
export const parseDailyCap = (raw: string): number | undefined => {
  const t = raw.trim();
  if (!t) return undefined;
  const n = Number(t);
  if (!Number.isFinite(n) || n < 0) return undefined;
  const r = Math.round(n);
  return r > MAX_DAILY_CAP ? undefined : r;
};

/**
 * 地址表文本 → 数组：按换行与逗号拆，trim、丢空、大小写不敏感去重（留第一次写法）。
 * 「a@x.co, b@x.co\n\n A@X.CO」→ ["a@x.co","b@x.co"]，粘一串进来不必先整理。
 */
export const splitAddressTable = (text: string): string[] => {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const piece of (text ?? "").split(/[\r\n,]+/)) {
    const v = piece.trim();
    if (!v) continue;
    const k = v.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(v);
  }
  return out;
};

/** 数组 → 地址表文本：一行一个；先过一遍拆分，所以重复与空行不会留在文本里 */
export const joinAddressTable = (list: readonly string[]): string =>
  splitAddressTable((list ?? []).join("\n")).join("\n");

/**
 * 从配置视图里取出地址表：后端给了 toList 就信它（那是拆好的权威），
 * 没给（老后端 / 字段缺失）就从 `to` 文本里拆 —— 两条路出来的都是规整过的数组。
 */
export const addressTableOf = (v: MailConfigViewFull): string[] =>
  Array.isArray(v.toList) && v.toList.length
    ? splitAddressTable(v.toList.join("\n"))
    : splitAddressTable(v.to);

/** 编辑一格（idx = null 是追加）：出来的永远是规整过的一行一个 */
export const addressTableSet = (
  text: string,
  idx: number | null,
  value: string,
): string => {
  const list = splitAddressTable(text);
  const v = value.trim();
  if (idx === null || idx < 0 || idx >= list.length) {
    if (v) list.push(v);
  } else if (v) list[idx] = v;
  else list.splice(idx, 1); // 把某一格清空 = 删掉这一行，表里不留下空地址
  return joinAddressTable(list);
};

/** 删一行（按下删除即提交到草稿，还没碰保存） */
export const addressTableRemove = (text: string, idx: number): string => {
  const list = splitAddressTable(text);
  if (idx >= 0 && idx < list.length) list.splice(idx, 1);
  return joinAddressTable(list);
};

/**
 * 这一格该不该进表：坏形状、重复、超上限各说一句；合法就空串。
 * 重复不分大小写 —— 表里留两份同一地址，后端会给同一个人寄两封。
 * 越界也在这里拦：EntityAddButton 会置灰，但弹页可能是满表前打开的。
 */
export const addressCellProblem = (
  value: string,
  list: readonly string[],
  idx: number | null,
): string => {
  const v = value.trim();
  if (!v) return "请填写收件地址";
  if (!isMailAddress(v)) return `「${v}」不像一个邮箱地址：只能有一个 @、域名里要带点`;
  const dup = list.findIndex(
    (x, i) => i !== idx && x.trim().toLowerCase() === v.toLowerCase(),
  );
  if (dup >= 0)
    return `这个地址已经在表里（第 ${dup + 1} 行）：要改就改那一行，别添第二份`;
  if (idx === null && list.length >= MAX_TO_ADDRESSES)
    return `默认收件地址最多 ${MAX_TO_ADDRESSES} 个：已经有 ${list.length} 个，先删一个再加`;
  return "";
};

/**
 * 地址表一行摘要：一个就念那一个，多个就「第一个 等 N 个」。
 * 发件箱的收件人也复用它（措辞不许两处各写一遍）；空表回空串。
 */
export const addressListSummary = (list: readonly string[]): string => {
  const l = splitAddressTable((list ?? []).join("\n"));
  if (!l.length) return "";
  if (l.length === 1) return l[0];
  return `${l[0]} 等 ${l.length} 个`;
};

/** 草稿里的收件地址表（按当前文本拆出来的）：列表行与校验共用同一份拆法 */
export const draftAddressTable = (d: MailDraft): string[] =>
  splitAddressTable(d.to);

/**
 * 「提醒寄副本」这一行的说法：关着是什么行为必须写在行上，
 * 不然人只会看到「未启用」，不知道自己少了一份离线兜底。
 */
export const sayMailSummary = (on: boolean): string =>
  on
    ? "开着：到点的提醒与盯梢，除在界面里说一声，另寄一份邮件副本"
    : "关着：提醒与盯梢只在界面里说，不往外寄邮件副本 —— 人不在这间屋子就听不到";

/** 这一行弹页/行上的补充说明（开关该怎么用才不踩坑） */
export const sayMailHint = (on: boolean): string =>
  on
    ? "副本走的就是左边那个发信账号：账号没启用或钥匙没配，副本一样寄不出去。"
    : "想要「人不在界面前也知道有事」再打开；每天寄几封仍受上面那个每日上限管着。";

/** 「收信落库」这一行的说法：关着 ≠ 收件箱是空的，这两件事必须分得清 */
export const inboxEnabledSummary = (on: boolean): string =>
  on
    ? "开着：收到的信落进收件箱，头部进清单、原件与正文另存"
    : "关着：还没接收件通道 —— 收件箱不会有新行，这不是「空」，是根本没接";

/** 收信开关的说明：把「先要有 MX」这件事说在前面，免得开了还是没信 */
export const inboxEnabledHint = (on: boolean): string =>
  on
    ? "这一档只管收进来的信落不落库；域名的 MX 有没有把邮件送到这台机器，是另一件事。"
    : "打开之前先确认域名的 MX 已经指到这台机器，否则信根本到不了这里，收件箱永远是那种「空」。";

/**
 * 草稿 → 请求体：可写的十一格，每格 trim；`to` 送规整过的地址表文本。
 * keyAvailable / lastSend 是后端事实，不回传；坏值由 mailMissingFields 先挡。
 */
export const mailPayloadOf = (d: MailDraft): MailConfigPatchFull => ({
  enabled: d.enabled,
  hostname: d.hostname.trim(),
  port: parsePort(d.port) ?? 0,
  secure: d.secure,
  username: d.username.trim(),
  keySecret: d.keySecret.trim(),
  from: d.from.trim(),
  to: joinAddressTable(splitAddressTable(d.to)),
  dailyCap: parseDailyCap(d.dailyCap) ?? 0,
  sayMail: d.sayMail,
  inboxEnabled: d.inboxEnabled,
});

/** 校验报的是哪一格：让调用方知道该把光标挪回哪儿 */
export type MailField =
  | "hostname"
  | "port"
  | "username"
  | "keySecret"
  | "from"
  | "to"
  | "dailyCap";

export interface MailFieldError {
  field: MailField;
  message: string;
}

/**
 * 邮箱形状：除「有 @、域名带点」外，尖括号与逗号空格一律不收 ——
 * 后端 assertSafeAddress 拦的就是这些（协议行是 `RCPT TO: <x>`，尖括号能插命令）。
 * 这里先挡，弹页里看到的是一句人话，不是 500。
 */
export const isMailAddress = (raw: string): boolean => {
  const v = raw.trim();
  if (!v || v.length > 254) return false;
  return /^[^\s@<>(),;:"']+@[^\s@<>(),;:"'.]+(\.[^\s@<>(),;:"'.]+)+$/.test(v);
};

/** wrangler secret put 认的变量名：字母或下划线开头，后面只允许字母、数字、下划线 */
export const isSecretName = (raw: string): boolean =>
  /^[A-Za-z_][A-Za-z0-9_]*$/.test(raw.trim());

/**
 * 主机名：只认字母、数字、点、连字符 —— 和后端 HOSTNAME_RE 同一条正则。
 * 带协议前缀或空格是复制粘贴时最常带进来的，那里当场 400，这里先挡住。
 */
export const isHostname = (raw: string): boolean =>
  /^[A-Za-z0-9.-]+$/.test(raw.trim());

/**
 * 变量名提示，空串 = 没要说。「像口令本体」只提示、不拦保存（同模型目录的 sk-
 * 条款）：那串也可能真是变量名。是否合法由 wrangler 与后端 400 定。
 */
export const keySecretHint = (raw: string): string => {
  const v = raw.trim();
  if (!v) return "填 secret 的变量名，不是口令本体";
  if (looksLikeRawKey(v))
    return "这串像是口令本体（sk- 开头）。这一栏填的是 secret 变量名，比如 SMTP_PASS；口令本体用 npx wrangler secret put SMTP_PASS 配进这台机器。";
  if (!isSecretName(v))
    return `「${v}」不像一个 secret 变量名：wrangler 收的名字只能由字母、数字、下划线组成，且不以数字开头。`;
  return "";
};

/** 那句要说给人的话（行摘要与弹页共用一份措辞，两处不许各写一遍） */
export const keyMissingSentence = (name: string): string =>
  `这台机器上还没有 ${name}，发不出去`;

/** 配法与模型目录同口径：变量名进 wrangler secret put */
export const keyMissingHint = (name: string): string =>
  name.trim()
    ? `${keyMissingSentence(name.trim())} —— 在终端跑 npx wrangler secret put ${name.trim()} 配上，再回到这里填变量名。`
    : "";

/**
 * 这一格填的变量名在这台机器上有没有：没改过就照后端的 keyAvailable；
 * 改过就不下结论（候选清单未必含邮件变量名，误报比不报更糟，等保存后回读）。
 */
export const draftKeyMissing = (
  secret: string,
  saved: { keySecret: string; keyAvailable: boolean },
): boolean => {
  const v = secret.trim();
  if (!v) return false;
  // 只有"这一格还是存着的那个名字"时才有事实可说（后端读过 env）。
  // 换成别的名字就下不了结论：候选清单是模型目录那本册子，压根不含邮件用的
  // 变量名，拿"不在册"当"这台机器上没配"是误报 —— 真实判定等保存后回读。
  return v === saved.keySecret.trim() ? !saved.keyAvailable : false;
};

/**
 * 换加密方式时端口跟着走：还停在另一种加密的标准门上就一起换对
 * （465 上走 STARTTLS、587 上做隐式 TLS 都连不上）；手填的端口不动。
 */
export const mailWithSecure = (d: MailDraft, next: boolean): MailDraft => {
  const p = d.port.trim();
  const implicit = IMPLICIT_TLS_PORTS.map(String);
  const starttls = String(STARTTLS_PORT);
  // next=true：当前停在 587 上就换到 465；next=false：当前在 465/997 上就换到 587
  const follow = next ? p === starttls : implicit.includes(p);
  if (!follow) return { ...d, secure: next };
  return { ...d, secure: next, port: next ? implicit[0] : starttls };
};

/**
 * 端口与加密方式搭不搭，空串 = 没要说。先说平台封的端口，再说门与握手对不上；
 * 后两条只提示不拦（契约允许），但基本连不通。
 */
export const securePortHint = (port: string, secure: boolean): string => {
  const n = parsePort(port);
  if (n === undefined) return "";
  if (BLOCKED_PORTS.includes(n)) return blockedPortMessage(n);
  const implicit = IMPLICIT_TLS_PORTS.includes(n);
  if (secure && !implicit)
    return `${n} 不是隐式 TLS 的门（465 / 997）：这一档该选「${secureLabel(false)} 起步」，否则握手当场失败。`;
  if (!secure && implicit)
    return `${n} 是隐式 TLS 的门：明文起步再 STARTTLS 通常连不上，这一档该选「${secureLabel(true)}」。`;
  return "";
};

/**
 * 必填校验：返回缺/坏的格子（顺序同弹页）。关着的配置允许半空 ——
 * 「还没配好」是正常状态；但填了的形状不对照样报，后端对形状是直接 400 的。
 */
export const mailMissingFields = (d: MailDraft): MailFieldError[] => {
  const out: MailFieldError[] = [];
  const push = (field: MailField, message: string) => out.push({ field, message });
  const host = d.hostname.trim();
  const port = d.port.trim();
  const secret = d.keySecret.trim();
  const cap = d.dailyCap.trim();
  const n = parsePort(port);

  if (d.enabled && !host) push("hostname", "请填写 SMTP 主机名");
  else if (host && !isHostname(host))
    push("hostname", `SMTP 主机名不合法：${host}`);

  if (d.enabled && !port) push("port", "请填写端口");
  else if (port && n === undefined) push("port", "端口得是 1 到 65535 的整数");
  else if (n !== undefined && BLOCKED_PORTS.includes(n)) push("port", blockedPortMessage(n));

  if (d.enabled && !d.username.trim()) push("username", "请填写登录用户名");
  if (d.enabled && !secret) push("keySecret", "请填写密钥变量名");
  else if (secret && !isSecretName(secret))
    push("keySecret", `「${secret}」不是合法的 secret 变量名：只能用字母、数字、下划线，且不以数字开头`);
  {
    const v = d.from.trim();
    if (d.enabled && !v) out.push({ field: "from", message: "请填写发件地址" });
    else if (v && !isMailAddress(v))
      out.push({ field: "from", message: `发件地址不像一个邮箱地址：${v}` });
  }
  // 收件人这一格是一张表：逐条过形状校验，超上限当场拦住 ——
  // 后端对整串文本只做「一行一个」的拆分，坏的那条会带着逗号或尖括号进协议行。
  {
    const list = splitAddressTable(d.to);
    if (d.enabled && !list.length)
      out.push({ field: "to", message: "请填写默认收件地址" });
    if (list.length > MAX_TO_ADDRESSES)
      out.push({
        field: "to",
        message: `默认收件地址最多 ${MAX_TO_ADDRESSES} 个：现在有 ${list.length} 个，删掉几个再保存`,
      });
    for (const bad of list.filter((x) => !isMailAddress(x)))
      out.push({
        field: "to",
        message: `收件地址「${bad}」不像一个邮箱地址：只能有一个 @、域名里要带点`,
      });
  }
  if (d.enabled && !cap) out.push({ field: "dailyCap", message: "请填写每日上限" });
  else if (cap && parseDailyCap(cap) === undefined)
    out.push({ field: "dailyCap", message: `每日上限得是 0 到 ${MAX_DAILY_CAP} 的整数` });
  return out;
};

/**
 * 行摘要：开没开、走的哪扇门、寄给谁、每天几封、用哪把钥匙。
 * 关着只说「未启用」，但钥匙不在机器上必须一起说 —— 否则打开了也发不出去。
 */
export const mailSummary = (v: MailConfigViewFull): string => {
  const missing = !!v.keySecret.trim() && !v.keyAvailable;
  if (!v.enabled)
    return missing ? `未启用 · ${keyMissingSentence(v.keySecret.trim())}` : "未启用";
  const to = addressListSummary(addressTableOf(v)) || "未填";
  const parts = [
    `${v.hostname.trim() || "主机名没填"}:${v.port} ${secureLabel(v.secure)}`,
    `发件 ${v.from || "未填"}`,
    `收件 ${to}`,
    `每日 ${v.dailyCap} 封`,
    `密钥变量 ${v.keySecret.trim() || "未填"}${missing ? "（未配置）" : ""}`,
  ];
  if (missing) parts.push(keyMissingSentence(v.keySecret.trim()));
  return parts.join(" · ");
};

/**
 * 最后一次发信的一行状态（只读）。时刻由调用方格式化 —— 怎么念 ISO 串是界面口径。
 */
export const lastSendNote = (last: MailLastSend | null, when = ""): string => {
  if (!last) return "";
  const at = when || last.at;
  const to = last.to ? `发到 ${last.to}` : "收件地址没记上";
  if (last.ok) return `最后一次发信成功：${at} ${to}`;
  // error 空串也算失败：后端没给原因得明说，不能留一行看着像没写完的话
  return `最后一次发信失败：${at} ${to}${last.error ? ` —— ${last.error}` : " —— 后端没给出原因"}`;
};

/**
 * 测试发送回执。测试接口仍收单个地址（表里头一个），表里另有几个也要说清，
 * 免得人以为全收到了。地址空着 = 用配置里已保存的那张表（后端口径）。
 */
export const testSentNote = (to: string, extra = 0): string => {
  const v = to.trim();
  const more = extra > 0 ? `（表里另有 ${extra} 个地址，这一封没寄给它们）` : "";
  if (v) return `测试邮件已发到 ${v}${more}`;
  return `测试邮件已按配置里的默认收件地址发出${extra > 0 ? `（表里另有 ${extra} 个地址）` : ""}`;
};
