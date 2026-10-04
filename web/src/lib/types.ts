// 后端 `src/agent/state.ts` 的镜像类型。
//
// 刻意不 import 后端文件：tsconfig.node/web 分离是为了避免 DOM 类型污染 Worker 侧，
// 反向 import 会把 Workers 全局类型带进浏览器侧。字段若变，两边一起改。

export const SHELVES = [
  "identity",
  "people",
  "projects",
  "knowledge",
  "patterns",
  "events",
  "reflections",
  "archive",
  "sessions",
] as const;

export type Shelf = (typeof SHELVES)[number];

export const SHELF_LABEL: Record<Shelf, string> = {
  identity: "身份",
  people: "人物",
  projects: "项目",
  knowledge: "知识",
  patterns: "模式",
  events: "事件",
  reflections: "反思",
  archive: "归档",
  sessions: "会话",
};

/**
 * 一段话的语气。后端 src/agent/state.ts 的 SENTIMENTS 与此一一对应。
 * 只给六个：再多就没人分得清 warm 和 bright 的差别了。
 */
export const SENTIMENTS = [
  "calm",
  "warm",
  "low",
  "tense",
  "bright",
  "tired",
] as const;
export type Sentiment = (typeof SENTIMENTS)[number];

export const SENTIMENT_LABEL: Record<Sentiment, string> = {
  calm: "平静",
  warm: "温软",
  low: "有点低",
  tense: "绷着",
  bright: "亮堂",
  tired: "乏",
};

/** 会话记忆左栏的一行：哪一场、记了几条、最后一次是什么时候 */
export interface SessionMemoryGroup {
  sessionId: string;
  title: string;
  n: number;
  last: string;
}

export interface MemEntry {
  id: string;
  date: string;
  type: string;
  tags: string[];
  weight: number;
  shelf: string;
  /** 归属人物（人脉视图用）；空串表示不属于任何具体的人 */
  person: string;
  /** 能不能给来客看。private = 只在我和管理员之间用；public = 管理员特意点了头的那几条 */
  visibility: "private" | "public";
  /**
   * 显式收回：管理员最后一次手动决定是「不公开」。压过 tag 门 ——
   * 收回之后 tag 门再开它也不出门。只听「公开 / 收回」按钮的。
   */
  hold?: boolean;
  content: string;
  accessed: number;
  /** 学到这条记忆的时刻（ISO）；和 date 不是一回事 */
  learned: string;
  /** 非空表示已被作废（值为替代它的记忆 id 或 retired）；空串表示还算数 */
  supersededBy: string;
  /** 会变（关于现状，会过期）还是稳定（关于他是谁，一直成立） */
  volatility: "stable" | "volatile";
  /** 上次被确认「现在还是这样」的时刻（ISO）；空串 = 从没确认过 */
  verified: string;
  /** 这件事从什么时候开始成立（ISO）。默认等于 learned */
  validAt: string;
  /** 到什么时候不再成立（ISO）；空串 = 到现在还算数 */
  invalidAt: string;
  /** 还没对上的那几条（记忆 id）：像在说同一件事，还没弄明白哪个算数 */
  conflictsWith: string[];
  /** 书册的标题（type=book 时有值）；条目和图像是空串 */
  title: string;
  /** 图像记忆指向的云盘文件 key（type=image 时有值），面板拿它把原图显示出来 */
  fileKey: string;
  /** 这条挂在哪一场对话上（会话记忆才有值）；空串表示它不属于任何一场 */
  sessionId: string;
  /** 这一段的语气（会话记忆才有值，见 SENTIMENTS）；空串 = 没标 */
  sentiment: string;
  /** 量级：这条事知道的人该有多少。AI 写入时按评分公式标，管理员可在这里改 */
  sensitivity: Sensitivity;
  /** 量级的评分依据（0-9 = AI 算的分；10 = 管理员亲手设的绝密） */
  score: number;
}

/** 记忆的量级，从轻到重五档（后端 state.ts 同款） */
export const SENSITIVITIES = [
  "trivial",
  "normal",
  "important",
  "secret",
  "topsecret",
] as const;

export type Sensitivity = (typeof SENSITIVITIES)[number];

export const SENSITIVITY_LABEL: Record<Sensitivity, string> = {
  trivial: "不重要",
  normal: "一般",
  important: "重要",
  secret: "机密",
  topsecret: "绝密",
};

/** tag 公开门槛的档位：到机密为止 —— 绝密没有出门这条路 */
export const TAG_GATE_LEVELS = [
  "trivial",
  "normal",
  "important",
  "secret",
] as const;

/** 一道开着的 tag 门：带这个 tag、量级不超过 maxLevel 的记忆，来客读得到 */
export interface TagGate {
  tag: string;
  maxLevel: string;
}

/** 一个 tag 的分布：几条、各量级多少 */
export interface TagStat {
  tag: string;
  n: number;
  trivial: number;
  normal: number;
  important: number;
  secret: number;
  topsecret: number;
}

export type TaskStatus = "todo" | "doing" | "done";

export interface Task {
  title: string;
  desc: string;
  status: TaskStatus;
  created: string;
}

export interface ToolStat {
  tool: string;
  count: number;
  ok: number;
  fail: number;
  totalMs: number;
  lastTs: number;
}

export interface Summary {
  ts: string;
  summary: string;
  msgCount: number;
}

/**
 * 他正等你回答的一个问题（后端 ask 工具写进来）。
 * 只留没答的那几条 —— 答完这张卡就该消失，答案会作为普通消息留在对话流里。
 */
export interface AskEntry {
  id: string;
  /** 他问的那句话 */
  text: string;
  /** 他给的候选（可空）。给了选项也允许自己写 */
  options: string[];
  /** 他为什么问 —— 答的人该知道这个答案会被拿去做哪一步 */
  why: string;
  askedAt: string;
  /** 归在哪一场：换了一场话题就不该还看见上一场的追问 */
  sessionId: string;
}

export interface ChatState {
  selfModel: string;
  selfModelVer: number;
  selfLog: string[];
  /** 他给自己定的要求（由他自己用 self 工具写）；空串 = 还没写过 */
  selfDemand: string;
  selfDemandVer: number;
  selfDemandLog: string[];
  /** 管理员自定义的人格提示词；为空表示用内置默认 */
  basePrompt: string;
  /**
   * 工具守则拆成了逐工具的稿子：name → 文本（空 = 用出厂默认）。
   * 一件工具一格，改 read_url 不影响 draw（见后端 src/agent/toolGroups.ts）。
   */
  toolPrompts: Record<string, string>;
  /** 组尾的追加稿：groupId → 文本（空 = 用出厂默认） */
  toolGroupNotes: Record<string, string>;
  /** 末栏「工具组使用风格」的覆盖稿（空 = 用出厂默认） */
  toolStyle: string;
  /** 来客那间另存一份：逐工具的覆盖稿 */
  guestToolPrompts: Record<string, string>;
  /** 来客那间的组尾覆盖稿 */
  guestToolGroupNotes: Record<string, string>;
  /** 来客那间的末栏风格覆盖稿 */
  guestToolStyle: string;
  /** 管理员自定义的回想守则（空 = 用内置默认） */
  recapPrompt: string;
  skills: Record<string, string[]>;
  tasks: Task[];
  /** 还摆在我眼前、没答的问题 */
  asks: AskEntry[];
  thinkMode: "normal" | "deep";
  /** 「深度思考」槽位指到哪条模型配置；空 = 跟普通模式同一套（回复风格页指派） */
  deepConfigId: string;
  toolStats: Record<string, ToolStat>;
  summaries: Summary[];
  /** 当前正在聊的会话 id，由后端维护；前端只读它来高亮列表 */
  activeSession: string;
  lastActive: number;
  userId: string;
  /** 来客自己报过的称呼（进门介绍页 / whoami 登记的；管理员房里是主人自己的，设置页可改）；空串 = 还没有 */
  guestName: string;
  /** 管理员的一句话签名（设置页「个人信息」里写的）；只进界面显示，不进提示词。空串 = 没写过 */
  adminBio: string;
  /** 来客类型档的快照（连接鉴权时从主人房取来，见后端 guestTypes.ts）；临时票没有这一格 */
  guestType?: GuestTypeInfo;
  /** 复盘游标：已经回看到第几条消息 */
  expUpto: number;
  /** 累计从经历里长出来的经验条数 */
  expCount: number;
  /** 朗读用哪副嗓子（音色 id，见 src/audio/tts.ts）；空串 = 还没挑，用默认 */
  voice: string;
  /**
   * 我此刻翻着的那一篇笔记（notes 表主键）；空串 = 没在看。
   * 它不只是界面状态：后端每轮拼提示词都会读它，于是说「这篇」的时候他知道是哪篇。
   */
  noteFocus: string;
  /**
   * 上一轮对话的上下文占用账（后端轮尾回写）；没聊过的场没有这一格。
   * 聊天头部拿它画「这一场聊到了窗口的几成」，顺带把缓存命中率放进提示里。
   */
  lastUsage?: LastUsage;
}

/** 一轮对话烧掉多少上下文（后端 onChatMessage 轮尾回写，见 src/agent/state.ts） */
export interface LastUsage {
  /** 记的是哪一场的账 —— 只在与当前场对上号时才显示 */
  sessionId: string;
  /** 输入 token 总量（含缓存命中与新写） */
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  /** 这扇门有多宽（token）；0 = 没设，用默认档 */
  contextWindow: number;
}

/** 附件的类别。决定服务端用哪条链路去读它 */
export type AttachKind =
  "image" | "text" | "pdf" | "audio" | "video" | "unknown";

/** 服务端读完一份附件的结果（见后端 src/agent/attach.ts） */
export interface Attachment {
  kind: AttachKind;
  name: string;
  size: number;
  /** 读到的正文；空串表示这次没读到 */
  text: string;
  /** 一句话结论：读到了什么，或者为什么读不到 */
  note: string;
  /** 已经拼好、可以直接接进消息正文的那一段 */
  block: string;
}

/** 还没连上（agent.state 为 undefined）时的占位，避免面板到处判空。 */
export const INITIAL_UI_STATE: ChatState = {
  selfModel: "",
  selfModelVer: 0,
  selfLog: [],
  selfDemand: "",
  selfDemandVer: 0,
  selfDemandLog: [],
  basePrompt: "",
  toolPrompts: {},
  toolGroupNotes: {},
  toolStyle: "",
  guestToolPrompts: {},
  guestToolGroupNotes: {},
  guestToolStyle: "",
  recapPrompt: "",
  skills: {},
  tasks: [],
  asks: [],
  thinkMode: "normal",
  deepConfigId: "",
  toolStats: {},
  summaries: [],
  activeSession: "",
  lastActive: 0,
  userId: "",
  guestName: "",
  adminBio: "",
  expUpto: 0,
  expCount: 0,
  voice: "",
  noteFocus: "",
};

export interface R2File {
  key: string;
  size: number;
  uploaded: string;
}

/** 单条消息的赞踩汇总。mine: 1 = 我赞过，-1 = 我踩过，0 = 没投 */
interface MsgVote {
  up: number;
  down: number;
  mine: number;
}

/** 消息上要显示的反馈徽标：votes 按 message id 索引，comments 是评论条数，flags 是被标重的消息 id */
export interface FeedbackSummary {
  votes: Record<string, MsgVote>;
  comments: Record<string, number>;
  flags: string[];
}

export interface MsgComment {
  id: string;
  messageId: string;
  /** "ai" = ericher，其余是登录角色（admin / user） */
  author: string;
  content: string;
  ts: number;
}

/** 一场会话的元信息。消息本体存在后端，列表里只需要这些。 */
export interface SessionMeta {
  id: string;
  title: string;
  /** private = 只有管理员看得见；public = 来客也能在「公开会话」里读 */
  visibility: "private" | "public";
  created: string;
  lastActive: string;
  /**
   * 置顶时刻（ISO）；空串 = 没置顶。侧栏用它分出置顶区，
   * 区内按这个时刻升序 —— 先顶上的一直在前，后顶上的顺次往后。
   */
  pinned: string;
  msgCount: number;
  /** 这场更早的部分已经被压缩成摘要（原文还在，只是不再整段发给我） */
  hasDigest: boolean;
  /** 收起来了：不删，只是从会话主列表挪到「已归档」分组，翻旧账照样搜得到 */
  archived: boolean;
  /** ericher 另开的一场、我还没看过：侧栏里先闪一下，之后留个角标，点进去就清 */
  unread: boolean;
  /** 这一场宿在哪间屋：空 = 宿在人屋（屋内多场的老模式）；非空 = 独立场屋（人屋--场id），前端按它换连接 */
  home: string;
}

/** 跨会话回忆的一次命中：哪一场、谁说的、说了什么 */
export interface RecallHit {
  sessionId: string;
  sessionTitle: string;
  lastActive: string;
  role: string;
  message: string;
}

/** 一条提醒。调度在后端，前端只负责展示与取消。 */
export interface Reminder {
  id: string;
  /** 约定这条提醒时所在的会话；到点那句话也回到那一场 */
  sessionId: string;
  what: string;
  /** 首次触发时刻（ISO 8601 带时区） */
  at: string;
  /** 非空表示重复提醒，值为 cron 表达式 */
  every: string;
  status: "pending" | "done" | "cancelled";
  created: string;
  firedAt: string;
  /** 必须叫醒：安静时段里的一次性提醒照说不误。默认 false */
  urgent: boolean;
  /** 到点这句话落在哪儿：same = 回到上面那一场，new = 他另开一场说（定时会话） */
  mode: "same" | "new";
  /** mode = new 时那一场的名字 */
  title: string;
}

/**
 * 今天的写额度账：一天 10 万行写入是整间屋子共用的，
 * 超了之后连「读」都会一起失败 —— 所以他每天会有一段时间整个人动不了。
 * 这个面板就是让那笔账看得见：到底是谁在写、写了多少。
 */
export interface WriteReport {
  /** UTC 日期，也就是额度所属的那一天（北京时间早八点换日） */
  day: string;
  writes: number;
  reads: number;
  writeCap: number;
  readCap: number;
  /** 最费额度的几处，降序。key 形如「insert:cf_agents_state」 */
  top: Array<{ key: string; n: number }>;
  /** 还在内存里、没落账的那部分 */
  pending: number;
}

/** AI neurons / Vectorize 的自计量（见 src/agent/usage.ts）。neurons 是估算口径。 */
export interface ResourceReport {
  day: string;
  /** 今天烧掉的 neurons（估算） */
  neurons: number;
  embeds: number;
  images: number;
  /** UTC 月（YYYY-MM），Vectorize 按月结算 */
  month: string;
  /** 本月查询过多少维 */
  vecQueriedDims: number;
  /** 当前存着多少维（近似存量） */
  vecStoredDims: number;
  neuronsCap: number;
  vecQueryCap: number;
  vecStoreCap: number;
}

/** Cloudflare 官方 Analytics 的精确数（见 src/analytics.ts）。没配 token 时是 null。 */
export interface OfficialUsage {
  day: string;
  requests: number | null;
  errors: number | null;
  subrequests: number | null;
  sqlRowsRead: number | null;
  sqlRowsWritten: number | null;
  /** 这份数是什么时候拿到的（毫秒时间戳）。官方口径有几分钟延迟。 */
  fetchedAt: number;
}

/** 额度总览：自计量 + 官方校准，一起回。 */
export interface UsageReport {
  writes: WriteReport;
  resources: ResourceReport;
  official: OfficialUsage | null;
}

/** 四个顶层页面：对话 / 笔记本 / 回想 / 设置 */
export type ViewKey = "chat" | "note" | "memory-session" | "settings";

/** 谁写的。user = 管理员，assistant = ericher 的笔迹；共用一个本子，但笔迹分得开 */
type NoteAuthor = "user" | "assistant";

export interface Note {
  id: string;
  title: string;
  /** Markdown 原文。存的是原样，渲染在前端 */
  body: string;
  tags: string[];
  author: NoteAuthor;
  updatedBy: NoteAuthor;
  pinned: boolean;
  created: string;
  updated: string;
}

/** 列表用的轻量视图：不带正文，只带一小段开头 */
export interface NoteMeta {
  id: string;
  title: string;
  tags: string[];
  author: NoteAuthor;
  updatedBy: NoteAuthor;
  pinned: boolean;
  created: string;
  updated: string;
  preview: string;
}

export interface NoteRevision {
  noteId: string;
  seq: number;
  title: string;
  body: string;
  savedAt: string;
  by: NoteAuthor;
}

/**
 * 一副嗓子的选项（读音选择界面用）。
 * 服务端把全部嗓音都回传，用不用得上一副一副标出来 ——
 * 不再把没配密钥的悄悄滤掉：那样用户只会看到「好音色怎么都没了」，却看不到原因。
 * 读音服务条目化之后：id 是读音配置的条目 id，provider 是协议名
 * （mimo-chat / doubao / glm-speech），不再枚举 —— 后端加协议不必等前端跟着改。
 */
export interface VoiceOption {
  id: string;
  label: string;
  provider: string;
  /** 一句话说明这个嗓子的性格，选的时候有依据 */
  desc: string;
  /** 这台机器现在用得上吗 */
  available: boolean;
  /** 用不上的原因；空串表示能用 */
  why: string;
}

/** 兼容别名：App 与朗读嗓音面板一直按 Voice 取数，形状与 VoiceOption 相同 */
export type Voice = VoiceOption;

/** 来客留痕的一笔（后端 src/agent/visitor.ts 的镜像）。
 *  留痕是明说的：介绍页承诺过，来客随时能翻自己那间的账。 */
export interface VisitorEvent {
  id: string;
  room: string;
  /** 记这笔时客人报过的称呼；空串 = 还没报过 */
  nickname: string;
  /** join / message / intro / panel */
  kind: string;
  detail: string;
  ts: string;
}

/** 来客名册的一行（管理面板用）。firstSeen/lastSeen 后端返回的就是 camelCase */
export interface VisitorRoom {
  room: string;
  nickname: string;
  firstSeen: string;
  lastSeen: string;
}

/** 来客类型的对外快照（连接鉴权/工具层流转的形状，无密码无停用位） */
export type GuestTypeInfo = Omit<GuestType, "active" | "created">;

/**
 * 来客类型（后端 guest-types 表的镜像）：一个自定义口令就是一类来客。
 * 用通用门禁口令进来的不在此列 —— 那种来客权限全开。
 * 口令在后端只存 SHA-256 摘要，不回显：忘了就重设一个。
 */
export interface GuestType {
  id: string;
  name: string;
  note: string;
  /**
   * 这一档开着的对外工具名（逐工具权益的权威）。
   * 空数组 = 显式全关；后端对老行会按旧开关推平一次。
   * 恒开的（天气/识图/卡片/留痕）不必写进来，后端会补上。
   */
  tools: string[];
  /** 长期权益：记事本（凭身份卡解锁） */
  permNotes: boolean;
  /** 长期权益：云盘上传（凭身份卡解锁） */
  permFiles: boolean;
  /** 长期权益：公开内容与公开文件（凭身份卡解锁） */
  permPublic: boolean;
  /** 停用后这个口令进不来，配置保留 */
  active: boolean;
  created: string;
}

/** 长期使用者的身份卡（后端 user_cards 的公开形状，无摘要） */
export interface UserCard {
  id: string;
  /** 全局唯一昵称：登卡的钥匙之一 */
  name: string;
  /** 目的声明：领卡时必填 */
  purpose: string;
  /** 联系邮箱：只登记不发送（项目没有邮件通道） */
  email: string;
  /** 归属权限档的 id；"common" = 走通用门禁口令领的卡 */
  typeId: string;
  /** 绑定的房间（对前端只是个名字，不用它做事） */
  room: string;
  created: string;
  lastSeen: string;
}

/** 公开墙上的一条：permPublic 持卡者贴的纸条，进门的人谁都看得到 */
export interface PublicPost {
  id: string;
  /** 发帖人卡 id：撤回时前端用它判断「这条是不是我贴的」 */
  cardId: string;
  /** 昵称快照：贴上墙那一刻的名字 */
  author: string;
  content: string;
  created: string;
}

// ── 工具名册（后端 src/agent/toolGroups.ts 的镜像，走 GET /api/tool-groups）──
//
// 「工具守则」面板与「来客权限」页都读它：组 → 工具，两侧（主人/来客）各自的
// 出厂稿与当前自定义。不写死在前端 —— 名册只有后端一份，写死两份必定对不上。

/** 工具语义组 */
type ToolGroupId =
  "read" | "visual" | "memory" | "todo" | "session" | "system";

export interface ToolGroupDef {
  id: ToolGroupId;
  label: string;
  /** 组标题下面的一句说明（只进界面，不进提示词） */
  hint: string;
}

/** 面板里的一件工具 */
export interface ToolCatalogTool {
  name: string;
  group: ToolGroupId;
  /** 常驻（schema 直接挂着）还是渐进（经 call_tool 调） */
  resident: boolean;
  owner: boolean;
  guest: boolean;
  /** 来客侧能不能单独开关；false 的是恒开，不参与权限矩阵 */
  guestTogglable: boolean;
}

/** 某一侧（主人/来客）的三格覆盖值 */
export interface ToolSideGuide {
  /** 逐工具的覆盖稿：name → 文本 */
  prompts: Record<string, string>;
  /** 组尾的追加稿：groupId → 文本 */
  groupNotes: Record<string, string>;
  /** 末栏「工具组使用风格」的覆盖稿 */
  style: string;
}

export interface ToolCatalog {
  groups: ToolGroupDef[];
  tools: ToolCatalogTool[];
  /** 出厂默认稿（「恢复默认」的对照） */
  defaults: { owner: ToolSideGuide; guest: ToolSideGuide };
  /** 当前自定义（空 = 用出厂稿） */
  current: { owner: ToolSideGuide; guest: ToolSideGuide };
}

/** 模型服务的接口格式。同一家的 baseUrl 换个路径就能换格式（各家的备注见 presets.ts） */
export type ModelFormat = "anthropic" | "openai-chat" | "openai-responses";

/** 读音服务的接法。决定这一条怎么发请求、参数叫什么名字 */
export type TtsProtocol = "mimo-chat" | "doubao" | "glm-speech";

/** 一家模型供应商：接哪一家的钥匙串（名称、地址、格式、Key 变量名），模型条目挂它底下 */
export interface ModelProvider {
  id: string;
  /** 供应商名称 */
  name: string;
  format: ModelFormat;
  baseUrl: string;
  /** Key 存的是 secret 变量名（wrangler secret put 过的），不是 Key 本身 */
  keySecret: string;
  /** 维护性调用（后台整理记忆之类的活）专用的 Key；空 = 用本家那把 */
  maintKeySecret: string;
  /** 维护性调用专用的小模型；空 = 复用当前生效的主线模型 */
  maintModel: string;
  created: string;
}

/** 一个模型条目：某家供应商底下的一个可用模型。active 的是正在载入的那个 */
export interface ModelEntry {
  id: string;
  providerId: string;
  model: string;
  /** 单次回复的输出上限（token）；0 = 用服务端默认 */
  maxOutput: number;
  /**
   * 最大上下文（token）；0 = 没设，界面回落到默认档。
   * 聊天头部拿它和 lastUsage 对比，显示这一场聊到了窗口的几成。
   */
  contextWindow: number;
  active: boolean;
  created: string;
}

/** 一条读音配置：一条就是一副可用的嗓子，排在最前且 Key 可用的那条是默认 */
export interface TtsConfig {
  id: string;
  name: string;
  protocol: TtsProtocol;
  baseUrl: string;
  /** Key 存的是 secret 变量名，不是 Key 本身 */
  keySecret: string;
  model: string;
  /** 音色 id；空 = 用服务端默认音色 */
  voice: string;
  /** 语气参数（目前只有 MiMo 式对话接口用得上） */
  style: string;
}

/** 绘图的出图协议。决定这一档怎么发请求、尺寸参数叫什么名字 */
export type DrawFormat = "workers-ai" | "siliconflow" | "zhipu";

/** 绘图配置：出图三档（fast 主力 / high 高质量 / fallback 兜底）各一条 */
export interface DrawConfig {
  tier: "fast" | "high" | "fallback";
  format: DrawFormat;
  /** 出图端点；workers-ai 走平台 AI 绑定，用不上 */
  endpoint: string;
  /** 模型名，降级有序：前面的先试，没成才轮到后面 */
  models: string[];
  /** Key 存的是 secret 变量名，不是 Key 本身；workers-ai 档为空 */
  keySecret: string;
  /** 结果标注里的供应商名 */
  label: string;
}

/** 联网搜索走的通道。Brave 独立索引没有摘要生成；Tavily 自带答案摘要与正文抓取 */
export type SearchFormat = "tavily" | "brave";

/** 联网搜索配置：单条（搜一下走哪家、用哪把钥匙） */
export interface SearchConfig {
  format: SearchFormat;
  /** Key 存的是 secret 变量名，不是 Key 本体 */
  keySecret: string;
}

/** 设置页左导航的条目。工具不在这些条目里 —— 它们在对话里被直接调用，只有技能配方归这里。 */
/** 外观主题：白纸黑字 / 晨曦微蓝 / 夜墨 / 跟随系统（见 theme.css 的 token 组） */
export type ThemeKey = "paper" | "dawn" | "dark" | "system";

export type SettingsKey =
  | "profile"
  | "about"
  | "style"
  | "memory"
  | "ledger"
  | "contact"
  | "session"
  | "file"
  | "visitors"
  | "guestTypes"
  | "guestPerms"
  | "modelConfigs"
  | "ttsConfigs"
  | "drawConfigs"
  | "searchConfigs"
  | "task"
  | "remind"
  | "skills"
  | "prompt"
  | "toolPrompt"
  | "recapPrompt"
  | "self"
  | "voice"
  | "appearance";
