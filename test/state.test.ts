// 设置页到底能改哪些字段 —— 这条闸是为了拦住一类特别难查的 bug。
//
// 起因：「朗读嗓音」做完了，前端老老实实发了 POST /api/config，后端也回了 200，
// 可界面上纹丝不动。查下来是 voice 这个新字段没被加进写入白名单 ——
// 请求本身是成功的，所以日志、网络面板、控制台全都干净，
// 只有用户看得见「点了没反应」。
//
// 所以这里把「每个 state 字段必须被归过一次类」变成一条会红的测试：
// 以后往 INITIAL_STATE 里加字段，要么进 PATCHABLE_KEYS（能被面板改），
// 要么进 RUNTIME_ONLY 并写清为什么不能被改，没有第三条路。

import { describe, expect, it } from "vitest";
import { DEFAULT_BASE_PROMPT } from "../src/agent/prompt";
import {
  INITIAL_STATE,
  PATCHABLE_KEYS,
  RUNTIME_ONLY,
  LEGACY_BASE_PROMPT_SNAPSHOT,
  LEGACY_BASE_PROMPT_V2,
  LEGACY_BASE_PROMPT_V3,
  LEGACY_BASE_PROMPT_V4,
  SEED_SELF_MODEL,
  migrateServiceCopy,
} from "../src/agent/state";
import type { ChatState } from "../src/agent/state";

describe("state 字段的写入归属", () => {
  const allKeys = Object.keys(INITIAL_STATE) as Array<keyof ChatState>;
  // 可选字段不在 INITIAL_STATE 里（老实例的 state 上本来就没有它们），
  // 但它们是 ChatState 的合法字段：归类名单里出现它们不算「已删掉的残留」。
  const optionalKeys: Array<keyof ChatState> = ["guestType", "usage"];

  it("每个字段都被归过类：可写 或 只由后端维护", () => {
    const classified = new Set<string>([
      ...PATCHABLE_KEYS,
      ...Object.keys(RUNTIME_ONLY),
    ]);
    const unclassified = allKeys.filter((k) => !classified.has(k));
    expect(
      unclassified,
      `这些字段既没进 PATCHABLE_KEYS 也没进 RUNTIME_ONLY。` +
        `如果它要能被设置页改，就加进 PATCHABLE_KEYS；否则加进 RUNTIME_ONLY 并写明理由。`,
    ).toEqual([]);
  });

  it("没有已经删掉的字段还留在名单里", () => {
    const live = new Set<string>([...allKeys, ...optionalKeys]);
    const stale = [...PATCHABLE_KEYS, ...Object.keys(RUNTIME_ONLY)].filter(
      (k) => !live.has(k),
    );
    expect(
      stale,
      "名单里的这些字段在 ChatState 上已经不存在了，删掉它们",
    ).toEqual([]);
  });

  it("两边不重叠：一个字段不能既给改又不给改", () => {
    const both = PATCHABLE_KEYS.filter((k) => k in RUNTIME_ONLY);
    expect(both).toEqual([]);
  });

  it("RUNTIME_ONLY 里每一条都写了理由", () => {
    for (const [key, why] of Object.entries(RUNTIME_ONLY)) {
      expect(
        why.trim().length,
        `${key} 没写「为什么不让前端改」`,
      ).toBeGreaterThan(4);
    }
  });

  it("朗读嗓音是可以被改的：这是这次踩到的那个坑", () => {
    expect(PATCHABLE_KEYS).toContain("voice");
  });

  it("guestName/adminBio 可以被面板改：PATCH 通道只归管理员，来客冒名的路没有开", () => {
    expect(PATCHABLE_KEYS).toContain("guestName");
    expect(PATCHABLE_KEYS).toContain("adminBio");
    expect(RUNTIME_ONLY.guestName).toBeUndefined();
  });
});

describe("服务向改版的存量迁移", () => {
  /** 一份「从未被管理员动过」的旧实例 state：三样都是旧默认的快照 */
  const legacyState = (): ChatState => ({
    ...INITIAL_STATE,
    basePrompt: LEGACY_BASE_PROMPT_SNAPSHOT,
    selfModel:
      "我的活：替小王接待来访者 —— 问清来意、办我能办的、把该带的话带到。" +
      "我的边界：小王的私事不聊、不替他做决定、行为留痕对来访者明说。" +
      "记忆从空白开始，随接待自己长。",
    skills: {
      接待来意: [
        "先复述对方的来意，确认没理解错",
        "能办的直接办（search / read_url / memory）",
        "办不了的说明是哪一档：我这边没有 / 得小王定",
      ],
      带话转交: [
        "memory add 记下来意与原话，person 填来客称呼",
        "当面说清「这条小王会看到」",
      ],
    },
  });

  it("快照原样的旧默认：三样全部换成新稿", () => {
    const patch = migrateServiceCopy(legacyState());
    expect(patch.basePrompt).toBe("");
    expect(patch.selfModel).toBe(SEED_SELF_MODEL);
    expect(patch.selfModelVer).toBe(2);
    const skills = JSON.stringify(patch.skills);
    expect(skills).not.toContain("小王");
    expect(patch.skills?.["接待来意"]?.join("")).toContain("得管理员定");
    expect(patch.selfLog?.at(-1)).toContain("默认稿迁移");
  });

  it("管理员真改过的稿子一字不动；技能按条判，只迁没动过的", () => {
    const s = legacyState();
    s.basePrompt = LEGACY_BASE_PROMPT_SNAPSHOT + "\n再补一句我自己的规矩。";
    s.selfModel = "这是我自己在接待里长出来的认知。";
    s.skills["接待来意"] = ["我自己改的步骤"];
    const patch = migrateServiceCopy(s);
    expect(patch.basePrompt).toBeUndefined();
    expect(patch.selfModel).toBeUndefined();
    // 改过的接待来意原样保留，原样的带话转交照常迁移
    expect(patch.skills?.["接待来意"]).toEqual(["我自己改的步骤"]);
    expect(patch.skills?.["带话转交"]?.join("")).toContain("管理员");
  });

  it("改了其中一样就只动那一样", () => {
    const s = legacyState();
    s.basePrompt = "完全自定义的守则。";
    const patch = migrateServiceCopy(s);
    expect(patch.basePrompt).toBeUndefined();
    expect(patch.selfModel).toBeDefined();
    expect(patch.skills).toBeDefined();
  });

  it("幂等：迁过的实例再跑一遍不产生任何写入", () => {
    const first = migrateServiceCopy(legacyState());
    const after = { ...legacyState(), ...first } as ChatState;
    const second = migrateServiceCopy(after);
    expect(Object.keys(second).length).toBe(0);
  });

  it("首次唤醒的新稿（seedPatch 出来的）本来就不需要迁移", () => {
    const s = legacyState();
    s.basePrompt = DEFAULT_BASE_PROMPT; // 新默认，与旧快照必然不同
    s.selfModel = SEED_SELF_MODEL;
    s.skills = {
      接待来意: [
        "先复述对方的来意，确认没理解错",
        "能办的直接办（search / read_url / memory）",
        "办不了的说明是哪一档：我这边没有 / 得管理员定",
      ],
      带话转交: [
        "memory add 记下来意与原话，person 填来客称呼",
        "当面说「我记下了，会转达给管理员」；转达走同步，可能失败，不打包票他一定看到",
      ],
    };
    expect(Object.keys(migrateServiceCopy(s)).length).toBe(0);
  });

  it("第二代快照（去身份但未清洗风味的默认稿）同样视为未自定义，就地换新", () => {
    const s = legacyState();
    s.selfModelVer = 1; // seedPatch 播种的代际
    s.basePrompt = LEGACY_BASE_PROMPT_V2;
    s.selfModel =
      "我的活：为眼前的用户接待 —— 问清来意、办我能办的、把办不了的记下来转达。" +
      "我的边界：后台的私事不聊、不替谁做决定、行为留痕对用户明说。" +
      "记忆从空白开始，随接待自己长。";
    s.skills = {
      接待来意: [
        "先复述对方的来意，确认没理解错",
        "能办的直接办（search / read_url / memory）",
        "办不了的说明是哪一档：我这边没有 / 得管理员定",
      ],
      带话转交: [
        "memory add 记下来意与原话，person 填来客称呼",
        "当面说「我记下了，会转达给管理员」；转达走同步，可能失败，不打包票他一定看到",
      ],
    };
    const patch = migrateServiceCopy(s);
    expect(patch.basePrompt).toBe("");
    expect(patch.selfModel).toBe(SEED_SELF_MODEL);
    expect(patch.selfModelVer).toBe(2);
    // 二代技能配方已无旧称谓，不该被误判成旧稿而重写
    expect(patch.skills).toBeUndefined();
  });

  it("第三代快照（风味统一前的默认稿）同样视为未自定义，守则就地换新", () => {
    const s = legacyState();
    s.selfModelVer = 2; // 风味清洗那一代播种后的代际
    s.basePrompt = LEGACY_BASE_PROMPT_V3;
    s.selfModel = SEED_SELF_MODEL; // 三代的自我认知与现稿一致，不必动
    // 技能配方在上一轮迁移里已经换成现代版，这一代不该再动
    s.skills = {
      接待来意: [
        "先复述对方的来意，确认没理解错",
        "能办的直接办（search / read_url / memory）",
        "办不了的说明是哪一档：我这边没有 / 得管理员定",
      ],
      带话转交: [
        "memory add 记下来意与原话，person 填来客称呼",
        "当面说「我记下了，会转达给管理员」；转达走同步，可能失败，不打包票他一定看到",
      ],
    };
    const patch = migrateServiceCopy(s);
    expect(patch.basePrompt).toBe("");
    expect(patch.selfModel).toBeUndefined();
    expect(patch.selfModelVer).toBeUndefined();
    expect(patch.skills).toBeUndefined();
  });

  it("第四代快照（编号小节版，本次改版前的默认稿）同样视为未自定义，守则就地换新", () => {
    const s = legacyState();
    s.selfModelVer = 2; // 与现稿同代，不必动
    s.basePrompt = LEGACY_BASE_PROMPT_V4;
    s.selfModel = SEED_SELF_MODEL;
    // 技能配方在前几轮迁移里已经换成现代版，这一代不该再动
    s.skills = {
      接待来意: [
        "先复述对方的来意，确认没理解错",
        "能办的直接办（search / read_url / memory）",
        "办不了的说明是哪一档：我这边没有 / 得管理员定",
      ],
      带话转交: [
        "memory add 记下来意与原话，person 填来客称呼",
        "当面说「我记下了，会转达给管理员」；转达走同步，可能失败，不打包票他一定看到",
      ],
    };
    const patch = migrateServiceCopy(s);
    expect(patch.basePrompt).toBe("");
    expect(patch.selfModel).toBeUndefined();
    expect(patch.selfModelVer).toBeUndefined();
    expect(patch.skills).toBeUndefined();
  });
});
