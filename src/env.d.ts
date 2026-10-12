// 补充 `wrangler types` 无法推断的 secrets（来自 `wrangler secret` 或 .dev.vars）。
// 本文件必须是全局脚本（无顶层 import/export），才能与生成的 worker-configuration.d.ts 声明合并。

// vite define 注入的构建期常量（见 vite.config.ts）：版本号是唯一新旧依据（/api/update-check），
// 构建号只作显示
declare const __APP_VERSION__: string;
declare const __GIT_HASH__: string;

interface CoworkSecrets {
  // ── LLM 推理 ──
  API_ENDPOINT: string;
  API_KEY: string;
  API_MODEL: string;
  AI_GATEWAY_URL?: string;
  SK_MAINTENANCE?: string;

  // ── 搜索（Tavily）──
  TAVILY_API_KEY?: string;

  // ── 记忆向量化 ──
  EMBED_MODEL?: string;

  // ── 门禁 ──
  GATE_PASSWORD?: string;
  ADMIN_PASSWORD?: string;
  SESSION_SECRET?: string;

  // ── 多模态 ──
  ZHIPU_KEY?: string;
  /** 硅基流动（siliconflow.cn）的 API Key：画图的高质量档走这里，没配就退回默认那条便宜的 */
  SILICONFLOW_API_KEY?: string;
  /** MiniMax（api.minimax.cn）的 API Key：聊天（M 系列）、语音（t2a_v2）、绘图（image_generation）共用这一把 */
  MINIMAX_KEY?: string;

  // ── 朗读与起标题（见 src/audio/tts.ts、src/mimo.ts）──
  /** 小米 MiMo 的 API Key（platform.xiaomimimo.com）：朗读用它合成，起标题用它生成。sk- 是按量付费，tp- 是 Token Plan，地址自动分路 */
  MIMO_API_KEY?: string;
  /** MiMo 接口地址覆盖；只有 key 来自第三方转发站时才需要设 */
  MIMO_TTS_URL?: string;
  /** MiMo 的 Anthropic 兼容根地址覆盖；同样只在走转发站时才需要设 */
  MIMO_API_BASE?: string;
  /** 起会话标题用的模型；不填就用内置的 mimo-v2.5-pro */
  MIMO_TITLE_MODEL?: string;
  /** 豆包 Seed-TTS 2.0 的 API Key；没配则退回智谱 GLM-TTS */
  DOUBAO_TTS_KEY?: string;
  /** 豆包音色 id 覆盖；不填则用内置默认音色 */
  DOUBAO_TTS_SPEAKER?: string;

  // ── 邮件（MailChannels 免费中继已停用，改 Resend）──
  RESEND_API_KEY?: string;
  EMAIL_FROM?: string;
  REPLY_TO_EMAIL?: string;

  // ── 网页矩阵（见 src/matrix/core.ts）──
  /**
   * 矩阵包推送令牌：配了之后，`POST /api/matrix/pack` 多认一种身份 ——
   * `Authorization: Bearer <token>`。给「本地/自动化直接把一个包推上云」用；
   * 不配则这条道整个关闭，推包只有工作台那一处。
   */
  MATRIX_PUSH_TOKEN?: string;

  // ── 官方用量校准（见 src/analytics.ts）──
  /** Cloudflare API Token（只要 Analytics:Read 权限）：查请求数和 DO 读写行的精确值。没配面板退回自计量 */
  CF_API_TOKEN?: string;
  /** 账号 id（非密，放 wrangler vars）：GraphQL 查询按它过滤 */
  CF_ACCOUNT_ID?: string;

  // ── 绑定（不是密钥，声明在这里只是为了不必每次都跑 `wrangler types`）──
  /**
   * Browser Run：read_url 取正文用（见 src/tools/search.ts 的 browserRead）。
   * 可选 —— 本机 dev 和不接这一档的部署退回「直连 + Jina」那条老链条。
   */
  BROWSER?: import("@cloudflare/puppeteer").BrowserWorker;
}

declare namespace Cloudflare {
  interface Env extends CoworkSecrets {}
}

// Agent<Env, State> 要求 Env extends Cloudflare.Env，故全局 Env 同样带上这些字段。
interface Env extends CoworkSecrets {}
