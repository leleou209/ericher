// 邮件设置表单里的纯规则：草稿与提交口径、必填校验、端口与加密方式的组合提示、
// secret 变量名的合法性、默认收件地址表（拆/拼/逐条形状校验/上限）、
// 两个新开关的说人话措辞、列表行摘要与发信回执文案。
//
// 为什么要外提：这一面只有一行、一个弹页，规则全写进 JSX 就没人测得住 ——
// 「465 配 STARTTLS 该不该提醒」「变量名填成口令本体怎么认」「两行地址只差大小写
// 该不该算重复」这类判断，改一句措辞就可能顺手把边界挪坏。抽成不依赖 React 的函数
// 才拿得住回归（测试环境是 node，没有 jsdom，组件渲染根本测不了）。
// 这里只有规则，不碰接口、不碰 DOM —— 提交口径仍由面板走 lib/api。

import { looksLikeRawKey } from "./modelCatalogForm";
import type {
  MailConfigPatchFull,
  MailConfigViewFull,
  MailLastSend,
} from "./types";

/** 界面收住的每日上限：再大基本是多打了几个 0，放过去每天的发送账就白记了 */
export const MAX_DAILY_CAP = 1000;

/**
 * 默认收件地址表的上限：这一张表进的是「没点名寄给谁时就去这里」那条路，
 * 二十个已经够一家人加一个群，再多基本是把抄送清单粘进来了（后端也收这么多）。
 */
export const MAX_TO_ADDRESSES = 20;

/** 隐式 TLS 的标准门（契约里 secure=true 说的就是这两扇） */
export const IMPLICIT_TLS_PORTS = [465, 997];

/** 明文起步 + STARTTLS 的标准门（契约里 secure=false 说的就是它） */
export const STARTTLS_PORT = 587;

/**
 * 平台禁止出站的端口：后端直接 400，这里当场拦住 ——
 * 让人按完保存才知道白填一场，不如现在就指着那一格说。
 */
export const BLOCKED_PORTS = [25];

export const blockedPortMessage = (n: number): string =>
  `${n} 端口这台机器出不去（平台禁止出站）：改 465 或 587`;

/** 加密方式 → 界面上那三个字：行摘要与提示共用，不在两处各写一份措辞 */
export const secureLabel = (secure: boolean): string =>
  secure ? "隐式TLS" : "STARTTLS";

/**
 * 弹页草稿：端口与每日上限是字符串 —— 还没敲完的「58」也是合法的编辑状态，
 * 塞成数字会把人正在打的字吞掉（和模型目录那两个额度格同一个做法）。
 * `to` 存的也是字符串：那是「地址表文本」，一行一个，界面按表来增删（见下面那组
 * splitAddressTable / joinAddressTable），提交前才拼回这一串。
 * 这一份草稿里永远没有口令：凭据只住 keySecret 所指的 Worker secret。
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
 * 每日上限：只认 0 到 MAX_DAILY_CAP；小数四舍五入（后端只收整数，1.5 放过去是 400）。
 * 超界不当「收在上限上」处理 —— 后端本来就 400 回绝，悄悄改写成人没填的数比报错更糟。
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
 * 地址表文本 → 数组：按换行（含 \r\n）与逗号拆开，逐条 trim、丢空、
 * 大小写不敏感去重（保留第一次出现的那种写法）。
 * 「a@x.co, b@x.co\n\n A@X.CO」→ ["a@x.co","b@x.co"] —— 从邮件客户端或聊天窗口
 * 粘一串进来是这个结果，人不必自己先整理。
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
 * 比重复不分大小写（邮件地址本来就这样折）—— 表里留两份同一个地址，
 * 后端会给同一个人寄两封，而这种错最难查。
 * 越界（idx=null 且已满上限）也在这里拦住：EntityAddButton 在满表时先置灰，
 * 但弹页可能是在表还没满时打开的，这一轮加满之后仍要拦得住。
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
 * 地址表的一行摘要：一个就念那一个，多个就「第一个 等 N 个」——
 * 发件箱里的收件人也用这一条（lib/mailBoxView 直接复用，措辞不许两处各写一遍）。
 * 空表回空串，由调用方决定那句「没填」怎么说。
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
 * 草稿 → 请求体：可写的那十一格（原九格 + 两个开关），每格 trim。
 * `to` 送的是规整过的地址表文本（一行一个）。
 * keyAvailable 与 lastSend 是后端算出来的事实，不回传。
 * 坏值由 mailMissingFields 先挡住，这里兜 0 只为让函数在任何输入下都有返回值。
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
 * 邮箱形状：除了「有 @ 、域名有点」，尖括号与逗号空格一律不收 ——
 * 后端 assertSafeAddress 拦的就是这些（协议行是 `RCPT TO: <x>`，尖括号进去能插命令）。
 * 这里先挡住，人在弹页里看到的是一句人话，不是服务器抛回来的 500。
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
 * 变量名那一格的提示，空串 = 没要说。
 * 「像口令本体」只提示、不拦保存（和模型目录里 sk- 那条款一致）：那串确实可能是
 * 某人给变量起的名字，前端替它判死会误伤。名字合不合法 wrangler 说了算，
 * 后端对不合法的名字是直接 400 的，所以那条由 mailMissingFields 拦下来。
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
 * 弹页里「这一格填的变量名在这台机器上有没有」：
 * 没改过就照后端那份只读事实 keyAvailable；改过了只能拿候选清单比一比 ——
 * 清单是空的（老后端没回）就不下结论，免得把明明配好的名字说成没配。
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
 * （465 上门走 STARTTLS、587 上做隐式 TLS 都连不上），
 * 手填过的端口留住不动 —— 人知道自己在干什么。和模型目录换格式时换地址同一做法。
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
 * 端口与加密方式搭不搭：空串 = 没要说。
 * 先说平台出不去的那几扇（后端直接 400），再说门与握手方式对不上；
 * 两种加密都是契约里的合法组合，所以后面那两条只提示不拦 —— 但基本连不通，值得说一句。
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
 * 必填校验：返回缺/坏的哪几格（都好了就空数组），顺序就是弹页里出现的顺序。
 * 关着的配置允许半空 —— 「还没配好」是正常状态，别拦着人先填一半存下来；
 * 但填了的东西形状不对照样报：后端对形状是直接 400 的，
 * 让人按完保存才知道白填一场，不如现在就指着那一格说。
 * trim 后才判空：「   」是手滑留下的空格，不是填过了。
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
 * 行摘要：一行看清开没开、走的哪扇门、寄给谁、每天几封、用哪把钥匙。
 * 关着就只说「未启用」—— 半配的状态不值得铺一排细节；
 * 但钥匙不在机器上这件事必须跟着说出来，不然人只看到「未启用」，
 * 不知道就算打开了也发不出去。
 * 收件人那张表折成「第一个 等 N 个」—— 行上不该被十个地址挤满。
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
 * 最后一次发信的一行状态（只读，不做输入）。时间由调用方格式化好传进来 ——
 * 怎么把 ISO 串念成人话是界面口径，不该被这条规则绑住。
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
 * 测试发送的回执。收件人是一张表，而这一封只寄给表里头一个（/api/mail/test
 * 那一格仍收单个地址），所以表里另有几个也要说清楚 ——
 * 不然人以为三个都收到了，实际只寄了一个。
 * 地址空着 = 用配置里已保存的那张表（后端口径）。
 */
export const testSentNote = (to: string, extra = 0): string => {
  const v = to.trim();
  const more = extra > 0 ? `（表里另有 ${extra} 个地址，这一封没寄给它们）` : "";
  if (v) return `测试邮件已发到 ${v}${more}`;
  return `测试邮件已按配置里的默认收件地址发出${extra > 0 ? `（表里另有 ${extra} 个地址）` : ""}`;
};
