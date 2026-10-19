import {
  Component,
  lazy,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { api, type Role } from "../lib/api";
import type {
  MatrixPage,
  ModelEntry,
  ModelProvider,
  ThemeKey,
  UserCard,
} from "../lib/types";
import { agentDisplay, useTheme } from "../lib/theme";
import {
  IDENTITY_BIO_MAX,
  IDENTITY_NAME_MAX,
  identityBioSummary,
  identityDraftOf,
  identityNameTitle,
  identityPayloadOf,
  type IdentityDraft,
} from "../lib/appearanceForm";
import {
  EntityRow,
  FormDialog,
  FormRow,
  FormSection,
  useDraft,
} from "./FormDialog";
import { Icon, type IconName } from "./Icons";
import { LoadingBoundary } from "./LoadingBoundary";
import { AppearancePanel, type AppearancePage } from "./ThemePanel";
import { MailPanel } from "./MailPanel";
import { MailInboxPanel, MailOutboxPanel } from "./MailBoxPanels";
import {
  ContactPanel,
  FilePanel,
  GuestPermsPanel,
  GuestTypesPanel,
  LedgerPanel,
  MemoryPanel,
  ModelConfigsPanel,
  PromptPanel,
  RecapGuidePanel,
  QuotaPanel,
  ReminderPanel,
  SelfPanel,
  SessionSection,
  SkillPanel,
  SearchConfigsPanel,
  TaskPanel,
  ToolGuidePanel,
  TtsConfigsPanel,
  VoicePanel,
  VisitorsPanel,
  deviceId,
  DrawConfigsPanel,
} from "./Panels";
import type {
  ChatState,
  RecallHit,
  SessionMeta,
  SettingsKey,
  ViewKey,
  Voice,
} from "../lib/types";
import "./Pages.css";
import "./AppearanceDialogs.css";

// 网页矩阵是挂在主体之外的一批自建网页：设置页只放一张状态卡（版本、规模、进工作台的门）。
// 完整管理界面在独立整页工作台（/assistant/workbench），页面预览与图谱要占满整页，
// 塞在设置抽屉里铺不开。两块都动态 import，不进主包首屏。
const MatrixStatus = lazy(() =>
  import("./MatrixStatus").then((m) => ({ default: m.MatrixStatus })),
);

type Patch = (patch: Partial<ChatState>) => Promise<void>;


// ── 设置页 ────────────────────────────────────────────

const GROUPS: Array<{
  title: string;
  /** 整组是外挂 / 试验性功能：标题旁挂一枚小标，和常规设置分开 */
  beta?: boolean;
  items: Array<{
    key: SettingsKey;
    label: string;
    icon: IconName;
    admin?: boolean;
    guest?: boolean;
  }>;
}> = [
  {
    title: "账户",
    items: [
      { key: "profile", label: "个人信息", icon: "user" },
      { key: "about", label: "关于", icon: "help-circle" },
    ],
  },
  {
    title: "对话",
    items: [
      { key: "style", label: "回复风格", icon: "message" },
      { key: "memory", label: "上下文记忆", icon: "book-open", admin: true },
      { key: "contact", label: "人物记忆", icon: "user", admin: true },
      // 账本与公开墙全员可见：账本是他记人记事的公开面，墙上贴着持卡者的纸条；
      // 管理员也看 —— 那块板子归他收拾
      { key: "ledger", label: "公开账本", icon: "book-open" },
    ],
  },
  {
    title: "能力",
    items: [
      { key: "skills", label: "技能配方", icon: "layers", admin: true },
      { key: "task", label: "任务清单", icon: "check" },
      { key: "remind", label: "提醒", icon: "bell", admin: true },
    ],
  },
  {
    // 邮件紧跟「能力」：它是提醒那类主动动作往外投递的出口，不是存东西的地方 ——
    // 放「储存内容」之后会让人觉得它是另一只柜子，而它其实是往外寄的一条门
    title: "寄信",
    items: [{ key: "mail", label: "邮件", icon: "share", admin: true }],
  },
  {
    title: "储存内容",
    items: [
      { key: "session", label: "会话记录", icon: "clock", admin: true },
      // 云盘跟着 permFiles 权益走（管理员天生有，见上面 groups 的过滤），
      // 不再钉死 admin —— 档位开了云盘的长期卡也该有自己的文件柜
      { key: "file", label: "云盘文件", icon: "clipboard" },
    ],
  },
  {
    title: "来客设置",
    items: [
      { key: "visitors", label: "来客", icon: "user", admin: true },
      { key: "guestTypes", label: "来客类型", icon: "bookmark", admin: true },
      { key: "guestPerms", label: "来客权限管理", icon: "check", admin: true },
    ],
  },
  {
    title: "模型配置",
    items: [
      { key: "modelConfigs", label: "模型配置", icon: "code", admin: true },
      { key: "ttsConfigs", label: "读音配置", icon: "volume", admin: true },
      { key: "drawConfigs", label: "绘图配置", icon: "image", admin: true },
      { key: "searchConfigs", label: "搜索配置", icon: "search", admin: true },
    ],
  },
  {
    title: "守则",
    items: [
      { key: "prompt", label: "工作守则", icon: "edit", admin: true },
      { key: "toolPrompt", label: "工具守则", icon: "code", admin: true },
      { key: "recapPrompt", label: "回想守则", icon: "clock", admin: true },
      { key: "self", label: "自我认知", icon: "compass", admin: true },
    ],
  },
  {
    title: "声音",
    items: [{ key: "voice", label: "朗读嗓音", icon: "mic", admin: true }],
  },
  {
    title: "外观",
    // 外观摊成四页：一页塞不下主题、壁纸、形象、弹页、动效、消息栏这一整套
    items: [
      { key: "appearance-theme", label: "主题", icon: "play" },
      { key: "appearance-color", label: "壁纸与配色", icon: "image" },
      { key: "appearance-face", label: "形象与弹页", icon: "user" },
      { key: "appearance-motion", label: "动效与消息", icon: "refresh" },
    ],
  },
  {
    // 扩展功能自成一栏：它们不是接待台的常设部件，
    // 混在常规设置里会让人觉得「天天都在用」—— 所以拎出来、并标 beta
    title: "扩展功能",
    beta: true,
    items: [
      // 网页矩阵：矩阵页挂在主域名下，管理面在独立整页工作台。
      // 进门资格不写死 admin：档位发了「权限矩阵」这一档长期权益的持卡来客也放行
      // （判定见下面 canMatrix，与云盘跟着 permFiles 走同一个套路）
      { key: "matrix", label: "网页矩阵", icon: "link" },
    ],
  },
];

const SECTION_META: Record<SettingsKey, { title: string; desc: string }> = {
  profile: { title: "个人信息", desc: "当前身份、设备与会话状态" },
  about: { title: "关于", desc: "这个 agent 是什么、跑在哪里" },
  style: {
    title: "回复风格",
    desc: "选择 ericher 回复你时的思考深度，并给两种模式各指派一套模型",
  },
  memory: {
    title: "上下文记忆",
    desc: "长期记忆库：按分类组织、可检索、可增删",
  },
  ledger: {
    title: "公开账本",
    desc: "ericher 公开给你看的人和事，加上公开权益的持卡者贴上墙的纸条",
  },
  contact: { title: "人物记忆", desc: "同一份记忆的另一种看法：按人翻" },
  session: { title: "会话记录", desc: "历史会话索引与会话摘要" },
  file: {
    title: "云盘文件",
    desc: "对话产物按会话归档，也可以自己建文件夹整理；改名、移动、删除都在行内",
  },
  visitors: {
    title: "来客",
    desc: "谁进过门、最近什么时候、都做了什么 —— 留痕当面说明过，也摊在这里",
  },
  guestTypes: {
    title: "来客类型",
    desc: "一个口令一类来客：名字、口令与接待说明 —— 能用哪些工具去「来客权限管理」",
  },
  guestPerms: {
    title: "来客权限管理",
    desc: "各档 × 各工具：逐件勾这一档能用什么，恒开的单独标出来",
  },
  matrix: {
    title: "网页矩阵",
    desc: "主域名下的一批自建网页：层级路径、按树导航、四档身份",
  },
  modelConfigs: {
    title: "模型配置",
    desc: "接哪家模型、用哪把钥匙；普通/深度各用哪个，去「回复风格」页指派",
  },
  ttsConfigs: {
    title: "读音配置",
    desc: "一条就是一副可用嗓子：协议、模型与音色都在这里配",
  },
  drawConfigs: {
    title: "绘图配置",
    desc: "出图三档各用哪家：端点、模型与 key 都在这里配，降级顺序即模型顺序",
  },
  searchConfigs: {
    title: "搜索配置",
    desc: "联网搜索走哪家：Tavily 或 Brave，配一把钥匙就升级，不配也能用免费通道",
  },
  mail: {
    title: "邮件",
    desc: "SMTP 发信账号：走哪扇门、用哪个变量名里的钥匙、每天寄几封；口令不进浏览器",
  },
  task: { title: "任务清单", desc: "待办、进行中、已完成" },
  remind: {
    title: "提醒",
    desc: "到点 ericher 会自己开口，这里管的是你们约好的那些事",
  },
  skills: {
    title: "技能配方",
    desc: "把常用的多步流程存成配方，下次一句话就能复用",
  },
  prompt: {
    title: "工作守则",
    desc: "ericher 的第一人称行为底稿，改完即刻生效",
  },
  toolPrompt: {
    title: "工具守则",
    desc: "一件工具一格：手里有哪些工具、什么话该用哪一件 —— 主人/来客两套分开改",
  },
  recapPrompt: {
    title: "回想守则",
    desc: "没人说话半小时后，她回头整理这场对话时读的提示词（默认出工作纪要，不带情绪）",
  },
  self: { title: "自我认知", desc: "ericher 对自己的理解，以及更新日志" },
  voice: { title: "朗读嗓音", desc: "ericher 念给你听时用的是哪副嗓子" },
  "appearance-theme": {
    title: "主题",
    desc: "四套内置纸色、自定义主题存档与主题包",
  },
  "appearance-color": {
    title: "壁纸与配色",
    desc: "基调色、六个落点的壁纸、功能块与按钮花纹、自定义 CSS",
  },
  "appearance-face": {
    title: "形象与弹页",
    desc: "ericher 的称呼与头像、界面图标覆盖、进站触发的弹页",
  },
  "appearance-motion": {
    title: "动效与消息",
    desc: "本机动效开关、主题级的动画档与消息栏风格",
  },
};

/**
 * 版本与更新：显示当前版本（package.json）与构建号（git 短 hash），
 * 点「检查更新」拿本地版本号去对开源仓库的版本号 —— 攒批推送是常态，
 * 两边的提交几乎永远对不上号，hash 不同不代表这边旧；
 * 开源仓的版本号（package.json，随发布走）比本地新，才是真的该更新。
 */
function VersionCard() {
  const [checking, setChecking] = useState(false);
  const [result, setResult] = useState<{
    upToDate: boolean;
    latest: {
      version: string;
      hash: string;
      message: string;
      date: string;
    } | null;
  } | null>(null);
  const [err, setErr] = useState("");

  const check = async () => {
    setChecking(true);
    setErr("");
    try {
      setResult(await api.updateCheck());
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setChecking(false);
    }
  };

  return (
    <div className="settings-card">
      <div className="card-header">
        <h3 className="card-title">版本与更新</h3>
        <p className="card-desc">
          版本号取自 package.json，构建号是发布时的那次提交
        </p>
      </div>
      <div className="toggle-list">
        <div className="toggle-row">
          <div className="toggle-info">
            <div className="toggle-icon">
              <Icon name="play" size={17} />
            </div>
            <div className="toggle-text">
              <div className="toggle-title">ericher v{__APP_VERSION__}</div>
              <div className="toggle-desc">构建 {__GIT_HASH__}</div>
            </div>
          </div>
          <button
            className="btn btn-ghost btn-sm"
            onClick={() => void check()}
            disabled={checking}
          >
            {checking ? "检查中…" : "检查更新"}
          </button>
        </div>
        {err && <p className="err">{err}</p>}
        {result && (
          <p className="meta">
            {result.upToDate
              ? result.latest
                ? `已是最新 —— 开源仓版本 v${result.latest.version}，不比这边新。`
                : "已是最新。"
              : result.latest
                ? `开源仓有新版本 v${result.latest.version}（构建 ${result.latest.hash}）：${result.latest.message}`
                : "开源仓库还没有版本信息。"}
          </p>
        )}
      </div>
    </div>
  );
}

/**
 * 模式指派：把模型目录里的条目分给「普通模式」和「深度思考」两个槽位。
 * 普通 = 载入中的那个条目（activate 语义）；深度 = 主屋 state.deepConfigId，
 * 空着表示跟普通同一个。删掉的条目会自动从槽位上摘下来（后端兜底）。
 *
 * 深度槽位为什么自己管一份值、不读眼前的 state：这个槽位是「全屋一把」的 ——
 * 模型目录只活在主屋的库里，聊天取深度目录也是去主屋取（fetchActiveCatalog
 * 跨间调 owner.deepCatalog），patchConfig 落的还是主屋。而设置页眼前的 state
 * 是当前这间场屋的，那份 deepConfigId 只是开场时从人屋抄的旧快照，写入的回推
 * 永远到不了它 —— 拿它当下拉的值，选完立刻弹回去，看着就像「切换不了」。
 * 所以读也走主屋（api.getConfig 落的就是主屋），选完就地改自己这份，不等回推。
 */
function StyleAssign({
  patch,
}: {
  patch: (p: { deepConfigId?: string }) => void;
}) {
  const [catalog, setCatalog] = useState<{
    providers: ModelProvider[];
    entries: ModelEntry[];
  } | null>(null);
  const [deep, setDeep] = useState("");

  useEffect(() => {
    void api
      .modelCatalog()
      .then((r) => setCatalog({ providers: r.providers, entries: r.entries }))
      .catch(() => setCatalog({ providers: [], entries: [] }));
    void api
      .getConfig()
      .then((cfg) => setDeep(cfg.deepConfigId || ""))
      .catch(() => undefined);
  }, []);

  if (catalog === null) return <p className="meta">模型目录读取中…</p>;
  const { providers, entries } = catalog;
  const labelOf = (e: ModelEntry) => {
    const p = providers.find((x) => x.id === e.providerId);
    return `${p ? p.name : "未知供应商"}（${e.model}）`;
  };
  const active = entries.find((e) => e.active) || null;

  return (
    <div className="style-assign">
      <p className="card-desc">
        两种模式各用哪个模型，从这里指派；换完下一轮对话生效。
      </p>
      <div className="style-assign-row">
        <span className="meta">普通模式用</span>
        <select
          className="field"
          value={active?.id ?? ""}
          disabled={!entries.length}
          onChange={(e) => {
            void api
              .modelEntryPatch({ id: e.target.value, active: true })
              .then(() => api.modelCatalog())
              .then((r) =>
                setCatalog({ providers: r.providers, entries: r.entries }),
              )
              .catch(() => undefined);
          }}
        >
          {!entries.length && <option value="">目录还是空的</option>}
          {entries.map((e) => (
            <option key={e.id} value={e.id}>
              {labelOf(e)}
            </option>
          ))}
        </select>
      </div>
      <div className="style-assign-row">
        <span className="meta">深度思考用</span>
        <select
          className="field"
          value={deep}
          disabled={!entries.length}
          onChange={(e) => {
            // 就地改自己这份，别等状态回推 —— 回推的是场屋那份，永远等不到
            setDeep(e.target.value);
            patch({ deepConfigId: e.target.value });
          }}
        >
          <option value="">跟普通模式同一套</option>
          {entries.map((e) => (
            <option key={e.id} value={e.id}>
              {labelOf(e)}
            </option>
          ))}
        </select>
      </div>
      {!entries.length && (
        <p className="meta">先到「模型配置」里加供应商和模型，再回来指派。</p>
      )}
    </div>
  );
}

/**
 * 管理员的个人信息：称呼 + 签名，一行只读摘要 + 点行开弹页。
 * 为什么不走来客那套卡：管理员一码通行，没有卡可领 ——
 * 这两格只是他自己房里的展示档案，存进 state，左下角那张身份卡照着显示。
 * 直接打 api.patchConfig 而不走 App 的 patch：那层把错误吞进聊天页的提示条，
 * 这里要的是「成没成」当场说清楚 —— 没成就不关窗，那句话摆在弹页里。
 */
function AdminIdentityFields({
  guestName,
  adminBio,
}: {
  guestName: string;
  adminBio: string;
}) {
  // 行读的是屋里的现值（服务器那份），改的都是开窗那一刻拍下的草稿
  const form = useDraft<IdentityDraft>(identityDraftOf(guestName, adminBio));
  const [dialog, setDialog] = useState(false);
  const [dialogErr, setDialogErr] = useState("");
  const [saving, setSaving] = useState(false);

  const open = () => {
    form.reset(identityDraftOf(guestName, adminBio));
    setDialogErr("");
    setDialog(true);
  };

  const close = () => {
    setDialog(false);
    setDialogErr("");
  };

  const save = async () => {
    if (saving) return;
    setSaving(true);
    setDialogErr("");
    try {
      await api.patchConfig(identityPayloadOf(form.draft));
      setDialog(false);
    } catch (e) {
      setDialogErr((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const patch = (p: Partial<IdentityDraft>) =>
    form.setDraft((prev) => ({ ...prev, ...p }));

  return (
    <>
      <div className="entity-list">
        <EntityRow
          title={identityNameTitle(guestName)}
          summary={identityBioSummary(adminBio)}
          onEdit={open}
        />
      </div>

      {dialog && (
        <FormDialog
          title="改称呼与签名"
          subtitle="左下角那张身份卡按这两格显示，按下保存才生效。"
          busy={saving}
          error={dialogErr}
          dirty={form.dirty(form.draft)}
          onClose={close}
          onSave={() => void save()}
        >
          <FormSection title="身份">
            <FormRow label="称呼" hint={`左下角身份卡显示的名字，最多 ${IDENTITY_NAME_MAX} 字`}>
              <input
                className="field"
                placeholder="怎么称呼你"
                maxLength={IDENTITY_NAME_MAX}
                value={form.draft.guestName}
                onChange={(e) => patch({ guestName: e.target.value })}
              />
            </FormRow>
            <FormRow
              label="签名"
              hint={`身份弹层里的一句话，选填，最多 ${IDENTITY_BIO_MAX} 字`}
              wide
            >
              <input
                className="field"
                placeholder="身份弹层里的一句话"
                maxLength={IDENTITY_BIO_MAX}
                value={form.draft.adminBio}
                onChange={(e) => patch({ adminBio: e.target.value })}
              />
            </FormRow>
          </FormSection>
        </FormDialog>
      )}
    </>
  );
}

export function SettingsPage({
  section,
  onSection,
  state,
  patch,
  isAdmin,
  role,
  card,
  canPublic,
  canFiles,
  onNav,
  sessions,
  activeSession,
  voices,
  voiceDefault,
  voiceCloud,
  onSwitchSession,
  onRenameSession,
  onDeleteSession,
  onToggleVisibility,
  onToggleArchive,
  onTogglePin,
  onLogout,
  online,
  motion,
  setMotion,
  theme,
  setTheme,
  setThink,
}: {
  section: SettingsKey;
  onSection: (s: SettingsKey) => void;
  state: ChatState;
  patch: Patch;
  isAdmin: boolean;
  role: Role;
  /** 当前登录者的卡；管理员和临时票是 null */
  card: UserCard | null;
  /** 有没有公开权益（公开墙的贴条资格） */
  canPublic: boolean;
  /** 有没有云盘权益（文件面板的进门资格；管理员天生有） */
  canFiles: boolean;
  onNav: (v: ViewKey) => void;
  sessions: SessionMeta[];
  activeSession: string;
  /** 这台机器上能用的嗓子；来客拿不到，就是空的 */
  voices: Voice[];
  /** 没选嗓音时实际会用哪一副 */
  voiceDefault: string;
  /** 这台机器接上云端嗓子了吗 */
  voiceCloud: boolean;
  onSwitchSession: (id: string, title: string) => void;
  onRenameSession: (s: SessionMeta) => void;
  onDeleteSession: (s: SessionMeta) => void;
  onToggleVisibility: (s: SessionMeta) => void;
  onToggleArchive: (s: SessionMeta) => void;
  onTogglePin: (s: SessionMeta) => void;
  onLogout: () => void;
  online: boolean;
  motion: boolean;
  setMotion: (v: boolean) => void;
  theme: ThemeKey;
  setTheme: (t: ThemeKey) => void;
  /** 调思考强度。和别的设置分开走：这一格来客也有，不能经过管理员那道路由 */
  setThink: (mode: "normal" | "deep") => void;
}) {
  // 主题域的 ThemeConfig：和纸色的 props.theme（ThemeKey）撞名，换个叫法拿
  const { theme: themeConfig } = useTheme();
  // 他叫什么、长什么样 —— 侧栏那张卡和「关于」都随主题
  const persona = agentDisplay(themeConfig);
  // 矩阵分区的进门资格：管理员天生有，来客要持卡且档位开了 permMatrix。
  // 名册读不到、后端是老版本没回这一格，都算没有（?? false）—— 整面网页不能靠猜
  const canMatrix = isAdmin || (!!card && (state.guestType?.permMatrix ?? false));
  const groups = useMemo(
    () =>
      GROUPS.map((g) => ({
        ...g,
        items: g.items.filter(
          (i) =>
            (!i.admin || isAdmin) &&
            (!i.guest || !isAdmin) &&
            // 云盘面板跟着权益走：管理员天生有，来客要长期卡 + 档位开了 permFiles
            (i.key !== "file" || canFiles) &&
            // 网页矩阵同上：要长期卡 + 档位开了 permMatrix（这一档给的是整面）
            (i.key !== "matrix" || canMatrix),
        ),
      })).filter((g) => g.items.length > 0),
    [isAdmin, canFiles, canMatrix],
  );
  const visible = useMemo(
    () => groups.flatMap((g) => g.items.map((i) => i.key)),
    [groups],
  );
  const meta = SECTION_META[section];
  // 外观四页共用同一个外壳（草稿住在壳里），所以这四页走同一个渲染口
  const isAppearance = section.startsWith("appearance");

  // 权限收窄（或分组变化）后，把停在隐藏分区上的选择拉回来
  useEffect(() => {
    if (!visible.includes(section) && visible.length) onSection(visible[0]);
  }, [visible, section, onSection]);

  return (
    <div className="settings-app">
      <aside className="settings-sidebar">
        <div className="sidebar-header">
          <button
            className="back-btn"
            title="返回对话"
            onClick={() => onNav("chat")}
          >
            <Icon name="arrow-left" size={17} />
          </button>
          <h1 className="sidebar-title">设置</h1>
        </div>

        <nav className="settings-nav">
          {groups.map((g) => (
            <div className="nav-group" key={g.title}>
              <div className="nav-group-title">
                {g.title}
                {g.beta && <span className="nav-beta">beta</span>}
              </div>
              {g.items.map((i) => (
                <button
                  key={i.key}
                  className={`nav-item ${section === i.key ? "on" : ""}`}
                  onClick={() => onSection(i.key)}
                >
                  <span className="nav-indicator" />
                  <Icon name={i.icon} size={16} />
                  <span className="nav-label">{i.label}</span>
                </button>
              ))}
            </div>
          ))}
        </nav>

        <div className="sidebar-footer">
          <div className="character-card">
            <div className="avatar-ring">
              <div className="character-avatar">
                {persona.avatar ? (
                  <img src={persona.avatar} alt="" />
                ) : (
                  persona.name.slice(0, 1)
                )}
              </div>
            </div>
            <div className="character-meta">
              <span className="character-name">{persona.name}</span>
              <span
                className="character-status"
                data-off={online ? "false" : "true"}
              >
                <span className="status-dot" />
                {online ? "在线" : "连接中"}
              </span>
            </div>
          </div>
        </div>
      </aside>

      <section className="settings-main">
        <div className="settings-scroll">
          <div className="settings-content">
            <header className="page-header">
              <h2 className="page-title">{meta.title}</h2>
              <p className="page-desc">{meta.desc}</p>
            </header>

            {section === "profile" && (
              <div className="settings-card">
                <div className="card-header">
                  <h3 className="card-title">身份</h3>
                  <p className="card-desc">
                    {isAdmin
                      ? "称呼和签名在这一行里改：点它就开窗，左下角那张身份卡按它显示，保存即刻生效"
                      : "登录状态由门禁密码决定，管理员才有写权限"}
                  </p>
                </div>
                {isAdmin ? (
                  <AdminIdentityFields
                    guestName={state.guestName}
                    adminBio={state.adminBio}
                  />
                ) : (
                  // 改不了的东西不该长成输入框的样子：一行文字就够了
                  <FormRow label="当前角色">
                    <span className="appearance-static">访客</span>
                  </FormRow>
                )}
                <FormRow label="设备标识（会话索引按它分片）">
                  <code className="appearance-static">{deviceId()}</code>
                </FormRow>
                <div className="toggle-list">
                  <div className="toggle-row">
                    <div className="toggle-info">
                      <div className="toggle-icon">
                        <Icon name="refresh" size={17} />
                      </div>
                      <div className="toggle-text">
                        <div className="toggle-title">连接状态</div>
                        <div className="toggle-desc">
                          {online ? "已连上 CoworkAgent" : "正在建立连接…"}
                        </div>
                      </div>
                    </div>
                    <span className={`tag ${online ? "ok" : "ghost"}`}>
                      {online ? "在线" : "连接中"}
                    </span>
                  </div>
                </div>
                <div className="row-actions" style={{ marginTop: 16 }}>
                  <button className="save-btn" onClick={onLogout}>
                    <Icon name="arrow-left" size={16} />
                    <span>退出登录</span>
                  </button>
                </div>
              </div>
            )}

            {section === "about" && (
              <div className="settings-card">
                <div className="card-header">
                  <h3 className="card-title">{persona.name}</h3>
                  <p className="card-desc">
                    接待台的助手：问清来意、办能办的事、办不了的如实转达
                  </p>
                </div>
                <div className="toggle-list">
                  <div className="toggle-row">
                    <div className="toggle-info">
                      <div className="toggle-icon">
                        <Icon name="layers" size={17} />
                      </div>
                      <div className="toggle-text">
                        <div className="toggle-title">运行形态</div>
                        <div className="toggle-desc">
                          Cloudflare Workers + Durable Object，状态持久在 agent
                          里
                        </div>
                      </div>
                    </div>
                  </div>
                  <div className="toggle-row">
                    <div className="toggle-info">
                      <div className="toggle-icon">
                        <Icon name="book-open" size={17} />
                      </div>
                      <div className="toggle-text">
                        <div className="toggle-title">记忆</div>
                        <div className="toggle-desc">
                          SQLite 记忆库，按分类组织，支持语义检索
                        </div>
                      </div>
                    </div>
                  </div>
                  <div className="toggle-row">
                    <div className="toggle-info">
                      <div className="toggle-icon">
                        <Icon name="clipboard" size={17} />
                      </div>
                      <div className="toggle-text">
                        <div className="toggle-title">文件</div>
                        <div className="toggle-desc">
                          R2 云盘，上传后 ericher 可以直接读
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            )}

            {/* 额度账只有管理员看得到：它是这间屋子的运行账，不是访客该操心的 */}
            {section === "about" && <VersionCard />}

            {section === "about" && isAdmin && (
              <div className="settings-card">
                <div className="card-header">
                  <h3 className="card-title">今天的额度</h3>
                  <p className="card-desc">
                    他每天能写 10 万行；写满了连翻记忆都做不到，要等早上八点重置
                  </p>
                </div>
                <QuotaPanel />
              </div>
            )}

            {section === "style" && (
              <div className="settings-card">
                <div className="card-header">
                  <h3 className="card-title">思考深度</h3>
                  <p className="card-desc">
                    深度模式会让 ericher 想得更久，也更愿意展开推理过程
                  </p>
                </div>
                <div className="style-options">
                  <label className="style-card">
                    <input
                      type="radio"
                      name="style"
                      checked={state.thinkMode !== "deep"}
                      onChange={() => setThink("normal")}
                    />
                    <div className="style-card-inner">
                      <div className="style-icon">
                        <Icon name="type" size={20} />
                      </div>
                      <div className="style-title">普通模式</div>
                      <div className="style-desc">直接给答案，快而不啰嗦</div>
                    </div>
                  </label>
                  <label className="style-card">
                    <input
                      type="radio"
                      name="style"
                      checked={state.thinkMode === "deep"}
                      onChange={() => setThink("deep")}
                    />
                    <div className="style-card-inner">
                      <div className="style-icon">
                        <Icon name="compass" size={20} />
                      </div>
                      <div className="style-title">深度思考</div>
                      <div className="style-desc">
                        先推理再作答，适合复杂问题
                      </div>
                    </div>
                  </label>
                </div>
                {isAdmin && <StyleAssign patch={patch} />}
              </div>
            )}

            {section === "voice" && (
              <div className="settings-card">
                <VoicePanel
                  voices={voices}
                  current={state.voice}
                  fallback={voiceDefault}
                  cloud={voiceCloud}
                  patch={patch}
                />
              </div>
            )}

            {section === "memory" && (
              <div className="settings-card">
                <MemoryPanel />
              </div>
            )}

            {section === "ledger" && (
              <div className="settings-card">
                <LedgerPanel
                  isAdmin={isAdmin}
                  cardId={card?.id ?? null}
                  canPublic={canPublic}
                />
              </div>
            )}

            {section === "contact" && (
              <div className="settings-card">
                <ContactPanel />
              </div>
            )}

            {section === "session" && (
              <div className="settings-card">
                <SessionSection
                  list={sessions}
                  active={activeSession}
                  onSwitch={onSwitchSession}
                  onRename={onRenameSession}
                  onDelete={onDeleteSession}
                  onToggleVisibility={onToggleVisibility}
                  onToggleArchive={onToggleArchive}
                  onTogglePin={onTogglePin}
                  summaries={state.summaries ?? []}
                />
              </div>
            )}

            {section === "file" && (
              <div className="settings-card">
                <FilePanel sessions={sessions} />
              </div>
            )}

            {section === "visitors" && (
              <div className="settings-card">
                <VisitorsPanel />
              </div>
            )}

            {section === "guestTypes" && (
              <div className="settings-card">
                <GuestTypesPanel />
              </div>
            )}

            {section === "guestPerms" && (
              <div className="settings-card">
                <GuestPermsPanel />
              </div>
            )}

            {section === "matrix" && (
              <div className="settings-card">
                <LoadingBoundary label="正在载入矩阵状态">
                  <MatrixStatus />
                </LoadingBoundary>
              </div>
            )}

            {section === "modelConfigs" && (
              <div className="settings-card">
                <ModelConfigsPanel />
              </div>
            )}

            {section === "ttsConfigs" && (
              <div className="settings-card">
                <TtsConfigsPanel />
              </div>
            )}

            {section === "drawConfigs" && (
              <div className="settings-card">
                <DrawConfigsPanel />
              </div>
            )}

            {section === "searchConfigs" && (
              <div className="settings-card">
                <SearchConfigsPanel />
              </div>
            )}

            {section === "mail" && (
              <>
                <div className="settings-card">
                  <MailPanel />
                </div>
                {/* 发件箱与收件箱各自一张卡：一本是「我往外寄过什么」，
                    一本是「外人寄进来什么」，混在一张里就成了没人敢翻的流水 */}
                <div className="settings-card">
                  <MailOutboxPanel />
                </div>
                <div className="settings-card">
                  <MailInboxPanel />
                </div>
              </>
            )}

            {section === "task" && (
              <div className="settings-card">
                <TaskPanel state={state} patch={patch} readOnly={!isAdmin} />
              </div>
            )}

            {section === "remind" && (
              <div className="settings-card">
                <ReminderPanel />
              </div>
            )}

            {section === "skills" && (
              <div className="settings-card">
                <div className="card-header">
                  <h3 className="card-title">技能配方</h3>
                  <p className="card-desc">
                    每行一步，写清让 ericher 怎么做；对话里说一句「用 XX
                    技能」他就会照着走
                  </p>
                </div>
                <SkillPanel state={state} patch={patch} />
              </div>
            )}

            {section === "prompt" && (
              <div className="settings-card">
                <PromptPanel state={state} patch={patch} />
              </div>
            )}

            {section === "toolPrompt" && (
              <div className="settings-card">
                <ToolGuidePanel state={state} patch={patch} />
              </div>
            )}

            {section === "recapPrompt" && (
              <div className="settings-card">
                <RecapGuidePanel state={state} patch={patch} />
              </div>
            )}

            {section === "self" && (
              <div className="settings-card">
                <SelfPanel state={state} patch={patch} />
              </div>
            )}

            {/* 外观摊成四个独立子页，共用同一个外壳 —— 位置固定、组件类型固定，
                切子页只是换 page 这个 prop，外壳不卸载，没保存的草稿不会丢 */}
            {isAppearance && (
              // 外层壳是给这四页专用的「松一档」间距标记；和 AppearancePanel 同生共死，
              // 换子页时它和里面的外壳都不卸载，草稿因此不会丢
              <div className="tp-appear">
                <AppearancePanel
                  page={section as AppearancePage}
                  isAdmin={isAdmin}
                  paperKey={theme}
                  setPaperKey={setTheme}
                  motion={motion}
                  setMotion={setMotion}
                />
              </div>
            )}
          </div>
        </div>
      </section>
    </div>
  );
}
