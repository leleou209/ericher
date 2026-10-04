// 工具注册表：把「我手里有什么」拆成「语义组 → 逐工具」两层，每层都可改。
//
// 为什么要拆：原来整块工具说明是一篇文章（prompt.ts 的 OWNER_TOOL_GUIDE），
// 管理员想改某个工具的用法，只能改整段 —— 而那一整段里还混着调用纪律、
// 场景分发这些跨工具的话。拆开之后：一件工具一格提示词，改 read_url 不影响
// draw；组自己的收尾话单独一格；跨组的话（调用纪律、场景分发、主动开口）
// 收在末尾「工具使用风格」那一格里。
//
// 它是**唯一**的一份工具名册：常驻/渐进、主人/来客、出厂默认稿都在这儿。
// tools/index.ts 从这里拿 RESIDENT_TOOLS / DEFERRED_TOOLS，prompt.ts 从这里拼
// 「8、我能用的工具」，接口从这里出组清单 —— 名册分家就会对不上号。
//
// 未来接 MCP：外部工具按时导入成工具（组名取 server 名），出厂默认稿取
// server 的 description；组清单的形状（组 → 工具 → 默认稿 + 当前自定义）不变。

/** 语义组的 id。顺序就是拼进提示词的顺序，也是面板上从上到下的顺序。 */
type GroupId =
  "read" | "visual" | "memory" | "todo" | "session" | "system";

export interface ToolGroupDef {
  id: GroupId;
  label: string;
  /** 面板上组标题下面的一句说明（只进界面，不进提示词） */
  hint: string;
}

export const TOOL_GROUPS: ToolGroupDef[] = [
  { id: "read", label: "查与读", hint: "搜、读网页、走站点、查天气" },
  { id: "visual", label: "图与卡片", hint: "画图、看图画图、出交互卡片" },
  {
    id: "memory",
    label: "记忆、笔记与文件",
    hint: "记忆库、旧会话、笔记本、云盘",
  },
  { id: "todo", label: "待办与提醒", hint: "任务清单与到点提醒" },
  { id: "session", label: "会话与提问", hint: "回头问他、另开一场" },
  { id: "system", label: "自我与系统", hint: "自我认知、技能、统计、整理" },
];

interface ToolDef {
  name: string;
  group: GroupId;
  /** 常驻（schema 直接挂进请求）还是渐进（经 call_tool 调） */
  resident: boolean;
  /** 主人那间有没有这件 */
  owner: boolean;
  /** 来客那间有没有这件（对外工具）；有的话才出现在来客提示词与权限页 */
  guest: boolean;
  /** 来客侧能不能单独开关。留痕是明说的，恒开，不参与权限矩阵 */
  guestTogglable: boolean;
  /** 主人那间的出厂默认稿（空 = 这件工具在主人侧不出现在提示词里） */
  ownerDefault: string;
  /** 来客那间的出厂默认稿（来客版与主人版分开写，不共用） */
  guestDefault: string;
}

/** 逐工具的出厂默认稿。措辞是第一人称的一句话，说清「什么时候用它、怎么用」。 */
export const TOOLS: ToolDef[] = [
  {
    name: "search",
    group: "read",
    resident: true,
    owner: true,
    guest: true,
    guestTogglable: true,
    ownerDefault: `联网搜索需要事实、新闻、书评、学术，关注翔实信息和区分真假。
任何我不确定的东西必须优先搜索 ，减少猜测。
我作为网络助手，积极饱和搜索是必须的。
如果事件复杂，可以先获取怎么搜索，那些网站权威，然后围绕这些网站和信息源开始`,
    guestDefault:
      "联网搜索。需要事实、新闻、书评、学术，或任何我不确定的东西，先搜 —— 凭训练数据猜的内容不可靠。",
  },
  {
    name: "read_url",
    group: "read",
    resident: true,
    owner: true,
    guest: true,
    guestTogglable: true,
    ownerDefault:
      "读一个已知网页的正文。标「免费通道」的搜索结果是别人的摘要，下判断先读原文；比搜索结果的片段完整。",
    guestDefault:
      "读一个已知网页的正文。标「免费通道」的搜索结果是别人的摘要，要下判断先读原文。",
  },
  {
    name: "browse",
    group: "read",
    resident: false,
    owner: true,
    guest: true,
    guestTogglable: true,
    ownerDefault:
      "微浏览器：打开页面拿正文和可继续点开的链接。按量使用，查询需完全，如果事件复杂，可以先获取怎么搜索，那些网站权威，然后围绕这些网站和信息源开始。",
    guestDefault:
      "打开页面拿正文和可继续点开的链接。一次点一两条，确认值得再继续；顺着链接无限走下去，是回避下结论。",
  },
  {
    name: "weather",
    group: "read",
    resident: true,
    owner: true,
    guest: true,
    // 天气/识图/卡片不设开关（不出网、不留东西），来客恒开
    guestTogglable: false,
    ownerDefault: "查天气。",
    guestDefault: "查天气。",
  },
  {
    name: "draw",
    group: "visual",
    resident: true,
    owner: true,
    guest: true,
    guestTogglable: true,
    ownerDefault: `画图：插画、封面、配图、场景、角色。默认那档便宜够用；
画日系动漫、二次元人物、立绘这类要求较高的，把 quality 提到 high。
提示词把主体、画风、构图、光线都写进去；
绘画结果自行检查，明显不对就改一版重画（只重画一次）。`,
    guestDefault:
      "画图：把一段描述变成一张图。主体、画风、构图、光线都写进提示词；画完自己看一眼，明显不对就改一版重画（只重画一次），把那行 markdown 原样放进回复，再说一句我为什么这么画。只回「画好了」却没带图，他手里什么都没有。",
  },
  {
    name: "view_image",
    group: "visual",
    resident: true,
    owner: true,
    guest: true,
    guestTogglable: false,
    ownerDefault: "调用图片来自行查看",
    guestDefault:
      "把云盘里的一张图调出来自己看。要看图里的文字（截图、书页、票据）就用它，照着念比转述准。",
  },
  {
    name: "diagram",
    group: "visual",
    resident: false,
    owner: true,
    guest: true,
    guestTogglable: true,
    ownerDefault: `写 mermaid 源码出示意图（流程/架构/时序/类/ER）：必填 mermaid + title；
必须当场调用，不许口头描述代替。
一张写全：层级、分支、循环都进图。
分层用 subgraph，适当处理。`,
    guestDefault:
      "他要的是讲清结构（流程、关系、数据）而不是好看时用它：我写 mermaid 源码出图，不许口头描述代替。一张写全：层级、分支、循环都进图。",
  },
  {
    name: "send_image",
    group: "visual",
    resident: false,
    owner: true,
    guest: true,
    guestTogglable: true,
    ownerDefault: `把云盘里存过的原图发回对话（key 或 query 二选一）。
区分好具体名称`,
    guestDefault:
      "把云盘里存过的原图发回对话（key 或 query 二选一）—— 重画的从来不是同一张。",
  },
  {
    name: "artifact",
    group: "visual",
    resident: false,
    owner: true,
    guest: true,
    guestTogglable: false,
    ownerDefault:
      "出交互卡片（沙箱里渲染的 HTML）：必填 title + html，必须自包含、浅色纸面、宽度自适应（手机也要能看）。存好后另起一行写 [artifact key 标题]，那行会变成卡片。",
    guestDefault:
      "出一张可交互的卡片（清单、对比表、步骤图）：必填 title + html，自包含、浅色纸面、宽度自适应。存好后另起一行写 [artifact key 标题]。",
  },
  {
    name: "memory",
    group: "memory",
    resident: false,
    owner: true,
    guest: true,
    guestTogglable: true,
    ownerDefault: `记忆库。action：search/add/list/people/person_lookup/supersede/restore/history/confirm/due_for_review/conflicts/coexist/delete/stats；
add 必填 content；
add 时标量级 —— 事理重要度+调动频率+是否强调三项相加，0-3 normal、4-7 important、8-9 secret、日常琐碎 trivial；
topsecret 只能由用户标注。`,
    guestDefault:
      "记下他说的事、翻公开与他名下的记录、记下他的称呼。记下的是这间屋的库，会试着同步给管理员那边，但同步可能失败，不把「他一定看到」说出口。",
  },
  {
    name: "recall",
    group: "memory",
    resident: false,
    owner: true,
    guest: false,
    guestTogglable: false,
    ownerDefault: `去以前的会话搜原话
可以依照用户语境猜测具体所属会话`,
    guestDefault: "",
  },
  {
    name: "session_memo",
    group: "memory",
    resident: false,
    owner: true,
    guest: false,
    guestTogglable: false,
    ownerDefault: `只在没人说话、我自己回头整理的那一轮用（必填 content）；
以整理信息、维持对话为主`,
    guestDefault: "",
  },
  {
    name: "note",
    group: "memory",
    resident: false,
    owner: true,
    guest: false,
    guestTogglable: false,
    ownerDefault: `笔记本内容查看。
action：new/read/write/append/delete/tag；
write/append/delete/tag 要 id（read 不给 id 读用户当前在读）。
new/write 必填 body。`,
    guestDefault: "",
  },
  {
    name: "files",
    group: "memory",
    resident: false,
    owner: true,
    guest: false,
    guestTogglable: false,
    ownerDefault: `云盘工具组：list/read/delete/clear/mkdir/move
（我没有 write能力；read/delete/move 要写key，move 写 to位置，clear 写 prefix，mkdir 记得填入 path）；
产物自动归档进 会话/<场id>/ 文件夹，需要时自行寻找。`,
    guestDefault: "",
  },
  {
    name: "task",
    group: "todo",
    resident: false,
    owner: true,
    guest: false,
    guestTogglable: false,
    ownerDefault: `任务清单。add 必填 title；
update/delete 必填 index（先 list 看，从 0 起）；
update 要 status（todo/doing/done）。
任务没有自动执行的能力，我必须自己主动推行已有的计划和提醒用户。`,
    guestDefault: "",
  },
  {
    name: "remind",
    group: "todo",
    resident: false,
    owner: true,
    guest: false,
    guestTogglable: false,
    ownerDefault: `定提醒。set 必填 what + at（ISO 带时区记得换算）；
every 必填翔实时间和内容；cancel 要 id（先 list 看）。`,
    guestDefault: "",
  },
  {
    name: "ask",
    group: "session",
    resident: true,
    owner: true,
    guest: false,
    guestTogglable: false,
    ownerDefault: `积极向用户提问，保证信息完全翔实再做决定。
提问前在句中做好解释和知识补充，避免用户能力不足导致解释不清。
做好选项分叉和意图猜测，尽可能让用户在选项中找到符合诉求的内容。
用户显示空回复，拒绝回复等先默认用户没想好，做出延申询问其真正意图，如果超过两次依然拒绝回复，可能存在其他问题，保持耐心与等待用户回复。`,
    guestDefault: "",
  },
  {
    name: "openSession",
    group: "session",
    resident: false,
    owner: true,
    guest: false,
    guestTogglable: false,
    ownerDefault: `在当前上下文过分拥堵或者另有要求时调用
content 是新场次的初始上下文；
填了 at 就是定时开启。
openSession某种意义上可以作为子agent使用，虽然我们目前没有开发会话互通和会话等级，但是有工具组可以查看会话记录，只是没有层次会导致列表混乱，因此非必要不拉取。`,
    guestDefault: "",
  },
  {
    name: "self",
    group: "system",
    resident: false,
    owner: true,
    guest: false,
    guestTogglable: false,
    ownerDefault: "自我认知（update 必填 content）。",
    guestDefault: "",
  },
  {
    name: "skill",
    group: "system",
    resident: false,
    owner: true,
    guest: false,
    guestTogglable: false,
    ownerDefault:
      "技能配方：把多步流程存成可复用的配方，run 时把步骤递回来由我用原生工具执行。",
    guestDefault: "",
  },
  {
    name: "stats",
    group: "system",
    resident: false,
    owner: true,
    guest: false,
    guestTogglable: false,
    ownerDefault: "记忆统计：看各分类现在有多少条。",
    guestDefault: "",
  },
  {
    name: "organize",
    group: "system",
    resident: false,
    owner: true,
    guest: false,
    guestTogglable: false,
    ownerDefault: "手工整理对话：萃取长期记忆与会话摘要。",
    guestDefault: "",
  },
  {
    name: "set_think_mode",
    group: "system",
    resident: false,
    owner: true,
    guest: false,
    guestTogglable: false,
    ownerDefault: "切深度思考（normal/deep）。",
    guestDefault: "",
  },
  {
    name: "feedback",
    group: "system",
    resident: false,
    owner: true,
    guest: false,
    guestTogglable: false,
    ownerDefault:
      "看他对我的赞踩与评论正文（action：signal/read/comment）；有评论用 feedback 读正文，只报条数等于漏掉。",
    guestDefault: "",
  },
  {
    name: "visitor_log",
    group: "memory",
    resident: false,
    owner: false,
    guest: true,
    guestTogglable: false,
    ownerDefault: "",
    guestDefault:
      "翻他在这间屋子的留痕：进门、留言、面板操作 —— 留痕是明说的，他问就摊开，我不删、不改、也不挑着念。",
  },
];

/** 主人那间的常驻工具名（推导自名册，别再手写一份：手写的那份一定会和这里对不上） */
export const RESIDENT_TOOLS = TOOLS.filter((t) => t.owner && t.resident).map(
  (t) => t.name,
) as ReadonlyArray<string>;

/**
 * 主人那间的渐进式工具名（schema 不进请求，经 call_tool 调）。
 * 只算主人那间有的：来客独有的（visitor_log）不在这里 —— 来客那间不拆层。
 */
export const DEFERRED_TOOLS = TOOLS.filter((t) => t.owner && !t.resident).map(
  (t) => t.name,
) as ReadonlyArray<string>;

/** 主人那间的工具名（按组序、组内按名册序） */
export const OWNER_TOOL_NAMES = TOOLS.filter((t) => t.owner).map((t) => t.name);

/** 来客那间的工具名 */
const GUEST_TOOL_NAMES = TOOLS.filter((t) => t.guest).map((t) => t.name);

/** 来客权限页上能单独开关的那些（恒开的不算） */
export const GUEST_TOGGLABLE_TOOLS = TOOLS.filter(
  (t) => t.guest && t.guestTogglable,
).map((t) => t.name);

/** 恒开、不参与开关的来客工具 */
export const GUEST_ALWAYS_ON = TOOLS.filter(
  (t) => t.guest && !t.guestTogglable,
).map((t) => t.name);

/**
 * 来客这间实际能用的工具：档位给的清单 ∩ 名册里的来客工具，再补上恒开的那些。
 * 清单 undefined（普通来客票、老 state）一律视为全开 —— 开关是「明确关掉才生效」
 * 的语义，缺省不能反着解释成全关。
 */
export function guestEnabledTools(enabled?: string[]): string[] {
  if (!enabled) return [...GUEST_TOOL_NAMES];
  const set = new Set([...enabled, ...GUEST_ALWAYS_ON]);
  return GUEST_TOOL_NAMES.filter((n) => set.has(n));
}

/** 一个工具在某一侧的出厂默认稿（不来客/无主人稿时为空串） */
export function toolDefault(name: string, guest: boolean): string {
  const t = TOOLS.find((x) => x.name === name);
  if (!t) return "";
  return guest ? t.guestDefault : t.ownerDefault;
}

// ── 组尾出厂稿 ────────────────────────────────────────────
// 一个组里几件工具共用的「什么时候用哪件」的话；写在组的末尾，
// 逐工具的稿子各说各的用法，这一块说它们之间的取舍。

const OWNER_GROUP_NOTES: Partial<Record<GroupId, string>> = {
  read: "需要事实、新闻或任何我不确定的东西，先 search；标「免费通道」的是别人的摘要，下判断先 read_url 读原文。已知是哪一页只要内容用 read_url；想直接调用浏览器即是browse。",
  visual: `讲清结构（流程、架构、时序、数据）用 diagram，画完同样把 markdown 放进回复
切记文生图画画不了逻辑结构图，两者分开。
回看图片用 send_image ；
云盘里的图要自己看用 view_image，经转述细节会丢。
我应当判断该配图、或画面本身值得看一眼时可以直接画，有疑问可以询问；
主要关注于如何表述信息。`,
  memory: `用户说保留信息或觉得信息有用，要使用记忆组件进行整理：
要原稿成篇用 note完整笔记md类型；
短事件和经验结论用 memory；
成体系的文章 memory type=book；
云盘 files 只放文件，如果用户需要可以帮忙存储。
本场会话没有额外记忆，如果记忆亏空先用 recall 搜原话。
用户发的附件可以在对话中查看，应当会存入云盘；
查没查到说实话即可。`,
  todo: `系统提示词里的「用户的赞踩」是用户真实的评价：被赞的方向多走，被踩的避开。
「用户标了重点」意味着此内容我需要加以重视。
包含提醒语句如「明天提醒我」或事情本身有时限，就用 remind 定下来。
晚上 23 点到早 8 点是一次性提醒的安静时段，可以往后推移，除开有特殊要求为例外。`,
  session: "依照需求调用",
  system: "会话结束可以扫一眼评论，取决于对话是否复杂，当然用户有时候会提醒。",
};

const GUEST_GROUP_NOTES: Partial<Record<GroupId, string>> = {
  read: "需要事实、新闻、书评、学术，或任何我不确定的东西，先 search。搜索结果标「免费通道」时那只是别人的摘要，不是原文；要下判断，先 read_url 打开原文。",
  visual:
    "讲清结构（流程、关系、数据）而不是好看时用 diagram；要好看的画面用 draw。他只要一段文字时，哪个都别硬塞。",
  memory:
    "他问「你们记了我什么」「我的留痕」时，用 visitor_log 把他在这间屋子的记录原样摊开。他说起自己的事、值得下次用上的那条用 memory 写下来。他打听管理员本人的事（在做什么、住哪、联系方式、家里有谁）时，不确认、不否认、不补任何细节：明说这些我不聊，把话头递回去。他托我带话给管理员时，接住并当面说「我记下了，会转达给管理员」—— 转达走同步，可能失败，不打包票他一定看到。",
};

function groupDefault(group: GroupId, guest: boolean): string {
  const map = guest ? GUEST_GROUP_NOTES : OWNER_GROUP_NOTES;
  return map[group] || "";
}

// ── 末栏「工具使用风格」出厂稿 ──────────────────────────────
// 跨组的话都收在这里：调用纪律、call_tool 的用法、一句话背后是哪个工具、
// 以及主动开口的分寸。整块可改，改完下一轮就生效。

const OWNER_STYLE_DEFAULT = `互不依赖的查询可以一批调用；有依赖的操作（先建再读、先删再改）必须等上一个结果回来再调 —— 同一批里的调用不保证先后次序。

call_tool 的用法：tool 填上面的名字，args 按速记给；拿不准参数就只传 tool，完整定义会递回来再调。参数没对上时错误里带着完整定义，照着改一遍就行。哪个工具用顺手了（累计两次），系统自动把它转成常驻，之后直接调。

用户的一句话背后常常是不同的工具，先分清再动手
- 「过会儿」「到点」：提他一句 remind；另开一场说件事 openSession；「照这个计划办」只是登记 task —— task 不会自己跑，skill 也只是把步骤递回来让我执行
- 「上次说的」：要当时的原话用 recall，要结论翻 memory；session_memo 是没人说话时我自己回头记的提要，不在对话里调
- 「出图」：好看的画面 draw，准确的结构 diagram，能点着玩的页面 artifact
-不确定自己能不能做某件事，直接说不确定，绝不编造。
- 默认已经看过我说过的每条消息用户都已经看到`;

const GUEST_STYLE_DEFAULT = `互不依赖的查询可以一批调用；有依赖的操作必须等上一个结果回来再调 —— 同一批里的调用不保证先后次序。

这间屋子没有任务、提醒、旧会话、笔记本、云盘那些工具：做不到的事直接说做不到，不用好听的话应付。若这间屋的档位关掉了记忆登记，memory 就不存在 —— 以「没有哪些工具」为准，别顺嘴答应「我记下了」。

不确定自己能不能做某件事时，直接说不确定，绝不编造不存在的功能或 API —— 编出来的功能，他真去用时会撞墙。`;

export function styleDefault(guest: boolean): string {
  return guest ? GUEST_STYLE_DEFAULT : OWNER_STYLE_DEFAULT;
}

/** 一组覆盖值（某一侧的全部自定义）。来客那间的这份跨间取，形状要能过 DO RPC */
export interface ToolSideGuide {
  /** 逐工具的覆盖稿：name → 文本 */
  prompts: Record<string, string>;
  /** 组尾的追加稿：groupId → 文本 */
  groupNotes: Record<string, string>;
  /** 末栏「工具使用风格」的覆盖稿 */
  style: string;
}

/** 组装工具说明时要用到的（都是「空 = 用出厂默认」的覆盖值） */
export interface ToolGuideInput extends Partial<ToolSideGuide> {
  guest: boolean;
  /**
   * 来客那间：这一档实际开着的工具名。给了就只列这些 —— 提示词里写着一件
   * 手上没有的工具，模型就会去调它，撞一鼻子灰。主人那间不用给（不裁）。
   */
  enabled?: string[];
}

const pick = (v: string | undefined): string => (v || "").trim();

/**
 * 拼「8、我能用的工具」。
 *
 * 顺序：末栏风格 → 组（组标题、组内逐工具、组尾）→ 完。
 * 逐工具那行标出常驻还是经 call_tool 调 —— 渐进式的没有 schema 在手边，
 * 不点明的话模型会直接调一个不存在的东西。
 */
export function buildToolGuide(input: ToolGuideInput): string {
  const { guest } = input;
  // 来客那间按档位剪一遍：只列这一档手上真有的；恒开的（天气/识图/卡片/留痕）
  // 一定在。主人那间不给 enabled，全列。
  const allowed = guest && input.enabled ? new Set(input.enabled) : null;
  const tools = TOOLS.filter((t) => {
    if (guest) return t.guest && (!allowed || allowed.has(t.name));
    return t.owner;
  });
  const lines: string[] = ["", "8、我能用的工具"];

  const style = pick(input.style) || styleDefault(guest);
  lines.push(style);

  for (const g of TOOL_GROUPS) {
    const members = tools.filter((t) => t.group === g.id);
    if (!members.length) continue;
    lines.push("", `【${g.label}】`);
    for (const t of members) {
      const body = pick(input.prompts?.[t.name]) || toolDefault(t.name, guest);
      if (!body) continue;
      const how = t.resident ? "直接调" : "经 call_tool 调";
      lines.push(`- ${t.name}（${how}）—— ${body}`);
    }
    const note = pick(input.groupNotes?.[g.id]) || groupDefault(g.id, guest);
    if (note) lines.push(note);
  }

  return "\n" + lines.join("\n");
}

// ── 面板要的名册形状 ────────────────────────────────────────
// 组、工具、两侧的出厂稿、以及当前自定义。未来接 MCP 时形状不变：
// 多几件工具、多一个组名而已，前端不用改。

/** 面板列一件工具要的元信息 */
export interface ToolCatalogTool {
  name: string;
  group: GroupId;
  /** 常驻（schema 直接挂着）还是渐进（经 call_tool 调） */
  resident: boolean;
  owner: boolean;
  guest: boolean;
  /** 来客侧能不能单独开关；false 的是恒开（天气/识图/卡片/留痕） */
  guestTogglable: boolean;
}

export interface ToolCatalog {
  groups: ToolGroupDef[];
  tools: ToolCatalogTool[];
  /** 出厂默认稿（「恢复默认」的对照） */
  defaults: { owner: ToolSideGuide; guest: ToolSideGuide };
  /** 当前自定义（空 = 用出厂稿） */
  current: { owner: ToolSideGuide; guest: ToolSideGuide };
}

/** 把名册 + 当前自定义拼成面板要的形状。纯函数，从 state 取 current 由调用方给。 */
export function toolCatalog(current: {
  owner: ToolSideGuide;
  guest: ToolSideGuide;
}): ToolCatalog {
  const side = (guest: boolean): ToolSideGuide => {
    const prompts: Record<string, string> = {};
    for (const t of TOOLS) {
      const d = toolDefault(t.name, guest);
      if (d) prompts[t.name] = d;
    }
    const groupNotes: Record<string, string> = {};
    for (const g of TOOL_GROUPS) {
      const d = groupDefault(g.id, guest);
      if (d) groupNotes[g.id] = d;
    }
    return { prompts, groupNotes, style: styleDefault(guest) };
  };
  return {
    groups: TOOL_GROUPS,
    tools: TOOLS.map((t) => ({
      name: t.name,
      group: t.group,
      resident: t.resident,
      owner: t.owner,
      guest: t.guest,
      guestTogglable: t.guestTogglable,
    })),
    defaults: { owner: side(false), guest: side(true) },
    current,
  };
}
