import { describe, expect, it } from "vitest";
import {
  IDENTITY_BIO_MAX,
  IDENTITY_NAME_MAX,
  archiveMissingFields,
  backgroundDimLabel,
  backgroundDraftOf,
  backgroundRowSummary,
  backgroundSizeChoices,
  backgroundSourceKind,
  backgroundSourceSummary,
  backgroundWithDraft,
  blankPopupDraft,
  buttonPatternSummary,
  firstUnusedIconName,
  humanBytes,
  iconMissingFields,
  iconOverrideEdited,
  iconOverridePatchOf,
  iconOverrideRemoved,
  iconOverrideSummary,
  identityBioSummary,
  identityDraftOf,
  identityNameTitle,
  identityPayloadOf,
  MAX_BG_POSITION,
  nextPopupId,
  normalizeBackgroundPosition,
  normalizeBackgroundSize,
  panelBgSummary,
  panelStylePatchOf,
  parseDelaySeconds,
  popupDraftOf,
  popupListEdited,
  popupListRemoved,
  popupListToggled,
  popupMissingFields,
  popupOf,
  popupRowTitle,
  popupSummary,
  snippet,
  themeSetSummary,
  type PopupFormDraft,
} from "./appearanceForm";
import {
  BACKGROUND_SCOPES,
  type BackgroundScope,
  type PopupTrigger,
  type ThemeBackground,
  type ThemePopup,
} from "./theme";

const bgRow = (over: Partial<ThemeBackground> = {}): ThemeBackground => ({
  src: "",
  dim: 0,
  blur: 0,
  position: "center",
  size: "cover",
  ...over,
});

const popupRow = (over: Partial<ThemePopup> = {}): ThemePopup => ({
  id: "popup-1",
  enabled: true,
  title: "周末歇业",
  body: "周日整天不开门",
  image: "",
  trigger: "load",
  delaySeconds: 0,
  actions: [],
  ...over,
});

const draftRow = (over: Partial<PopupFormDraft> = {}): PopupFormDraft => ({
  ...blankPopupDraft("popup-1"),
  title: "周末歇业",
  body: "周日整天不开门",
  ...over,
});

describe("弹页必填报的是缺哪几项", () => {
  it("标题与正文都空只报一条，说的是「至少填一个」", () => {
    const missing = popupMissingFields(draftRow({ title: "", body: "" }));
    expect(missing).toHaveLength(1);
    expect(missing[0].field).toBe("title");
    expect(missing[0].message).toContain("至少填一个");
  });
  it("纯空格算空：手滑留下的空格不是内容", () => {
    expect(popupMissingFields(draftRow({ title: "  ", body: "\n\t " })))
      .toHaveLength(1);
    expect(popupMissingFields(draftRow({ title: " ", body: "有事通知" }))).toEqual(
      [],
    );
  });
  it("标题或正文有一个就放行", () => {
    expect(popupMissingFields(draftRow({ title: "只有标题", body: "" }))).toEqual(
      [],
    );
  });
  it("动作按钮只填一半：报缺的那一格，序号指得准", () => {
    const onlyLabel = popupMissingFields(
      draftRow({ actions: [{ label: "去看看", to: "  " }] }),
    );
    expect(onlyLabel).toHaveLength(1);
    expect(onlyLabel[0].message).toBe("第 1 个按钮没写去向");
    const onlyTo = popupMissingFields(
      draftRow({ actions: [{ label: "", to: "/show" }] }),
    );
    expect(onlyTo[0].message).toBe("第 1 个按钮没写文字");
  });
  it("第二个按钮出错就说第二个", () => {
    const missing = popupMissingFields(
      draftRow({
        actions: [
          { label: "去看看", to: "/show" },
          { label: "顺便", to: "" },
        ],
      }),
    );
    expect(missing.map((m) => m.message)).toEqual(["第 2 个按钮没写去向"]);
  });
  it("两格全空的动作按钮不算缺项（没打算加，提交时丢掉）", () => {
    expect(
      popupMissingFields(draftRow({ actions: [{ label: "", to: "" }] })),
    ).toEqual([]);
  });
  it("站外跳法与协议相对的去向当场拦下来", () => {
    for (const to of ["javascript:alert(1)", "//host/x", "/\\host/x", "show"]) {
      expect(popupMissingFields(draftRow({ actions: [{ label: "去", to }] })))
        .toHaveLength(1);
    }
    for (const to of ["/show", "https://a.b/c", "HTTPS://a.b/c"]) {
      expect(popupMissingFields(draftRow({ actions: [{ label: "去", to }] })))
        .toEqual([]);
    }
  });
});

describe("弹页草稿 → 提交形态的归一", () => {
  it("延迟秒数：留空、不像数字、负数都按 0，小数往下取，超上限封顶", () => {
    expect(parseDelaySeconds("")).toBe(0);
    expect(parseDelaySeconds("   ")).toBe(0);
    expect(parseDelaySeconds("abc")).toBe(0);
    expect(parseDelaySeconds("-5")).toBe(0);
    expect(parseDelaySeconds("12.7")).toBe(12);
    expect(parseDelaySeconds(" 20 ")).toBe(20);
    expect(parseDelaySeconds("99999")).toBe(3600);
  });
  it("三格都 trim 后交出去，id 与启停原样带过去", () => {
    const p = popupOf(draftRow({ title: "  周末歇业  ", body: "  不开门  ", image: " asset:a.png " }));
    expect(p.title).toBe("周末歇业");
    expect(p.body).toBe("不开门");
    expect(p.image).toBe("asset:a.png");
    expect(p.id).toBe("popup-1");
    expect(p.enabled).toBe(true);
  });
  it("填了一半的按钮被丢掉，第三条超出封顶只留两个", () => {
    const p = popupOf(
      draftRow({
        actions: [
          { label: " 去看看 ", to: " /show " },
          { label: "只写了一半", to: "" },
          { label: "", to: "" },
          { label: "第三个", to: "/third" },
        ],
      }),
    );
    expect(p.actions).toEqual([
      { label: "去看看", to: "/show" },
      { label: "第三个", to: "/third" },
    ]);
  });
  it("打开弹页拍快照：0 秒照原样写回框里，不假装没填", () => {
    expect(popupDraftOf(popupRow({ delaySeconds: 0 })).delaySeconds).toBe("0");
    expect(popupDraftOf(popupRow({ delaySeconds: 20 })).delaySeconds).toBe("20");
    expect(popupDraftOf(popupRow({ enabled: false })).enabled).toBe(false);
  });
});

describe("弹页列表的整组算法", () => {
  const list = [popupRow({ id: "popup-1" }), popupRow({ id: "popup-2" })];
  it("新条目的 id 避开已有的", () => {
    expect(nextPopupId([])).toBe("popup-1");
    expect(nextPopupId(["popup-1"])).toBe("popup-2");
    expect(nextPopupId(["popup-1", "popup-2", "custom-id"])).toBe("popup-3");
  });
  it("新增追加到队尾，编辑原位换掉 —— 顺序就是来客看到顺序", () => {
    const third = popupRow({ id: "popup-3", title: "第三条" });
    expect(popupListEdited(list, "", third).map((p) => p.id)).toEqual([
      "popup-1",
      "popup-2",
      "popup-3",
    ]);
    const edited = popupRow({ id: "popup-2", title: "改过的第二条" });
    expect(popupListEdited(list, "popup-2", edited).map((p) => p.title)).toEqual(
      ["周末歇业", "改过的第二条"],
    );
  });
  it("删除只剩另一条；启停只翻 enabled，正文一个字都不动", () => {
    expect(popupListRemoved(list, "popup-1").map((p) => p.id)).toEqual([
      "popup-2",
    ]);
    const toggled = popupListToggled(list, "popup-1");
    expect(toggled[0].enabled).toBe(false);
    expect(toggled[0].body).toBe(list[0].body);
    expect(toggled[1]).toEqual(list[1]);
  });
});

describe("弹页行摘要", () => {
  it("没有按钮 / 只有标题这两档边界都写成话", () => {
    expect(popupSummary(popupRow({ body: "", actions: [] }))).toContain(
      "没有按钮",
    );
    expect(popupSummary(popupRow({ body: "  " }))).toContain("只有标题");
  });
  it("一行看清什么时候弹、有没有图、几个按钮", () => {
    const s = popupSummary(
      popupRow({ trigger: "delay", delaySeconds: 20, image: "asset:a.png", actions: [{ label: "去", to: "/x" }] }),
    );
    expect(s).toBe("进站后延时 20 秒 · 带插图 · 1 个按钮 · 「周日整天不开门」");
  });
  it("停用的排最前", () => {
    expect(popupSummary(popupRow({ enabled: false })).startsWith("已停用")).toBe(
      true,
    );
  });
  it("超长正文截住，不把行撑破", () => {
    const long = "啊".repeat(200);
    const s = popupSummary(popupRow({ body: long }));
    expect(s).toContain(`「${"啊".repeat(34)}…」`);
    expect(s.length).toBeLessThan(80);
  });
  it("认得的触发方式照字说，认不得的原样显示不漏成空白", () => {
    expect(popupSummary(popupRow({ trigger: "daily" })).startsWith("每天一次")).toBe(true);
    const odd = popupRow({ trigger: "onFullMoon" as PopupTrigger });
    expect(popupSummary(odd)).toContain("onFullMoon");
  });
  it("没标题的行也有个名字可点", () => {
    expect(popupRowTitle("  ")).toBe("未命名告示");
    expect(popupRowTitle(" 周末 ")).toBe("周末");
  });
});

describe("图标覆盖：后端只认「删掉的显式发 null」", () => {
  it("新增给值，服务器上多出来的键补 null", () => {
    const patch = iconOverridePatchOf(
      { home: "asset:a.png", user: "https://a.b/u.png" },
      { home: "asset:old.png", bell: "asset:b.png" },
    );
    expect(patch).toEqual({
      home: "asset:a.png",
      user: "https://a.b/u.png",
      bell: null,
    });
  });
  it("空覆盖表配上服务器那份 = 全部补 null（什么都不动就一条也清不掉）", () => {
    expect(iconOverridePatchOf({}, { home: "asset:a.png" })).toEqual({
      home: null,
    });
  });
  it("一条没变时不该多出任何 null 键", () => {
    const same = { home: "asset:a.png" };
    expect(Object.values(iconOverridePatchOf(same, same)).includes(null)).toBe(
      false,
    );
  });
  it("弹页保存：改名要把旧名字从表里摘掉，新增不挤掉别人", () => {
    const current = { home: "asset:a.png", user: "asset:u.png" };
    expect(iconOverrideEdited(current, "home", { name: "search", ref: "asset:s.png" })).toEqual({
      user: "asset:u.png",
      search: "asset:s.png",
    });
    expect(iconOverrideEdited(current, "", { name: "home", ref: "asset:b.png" })).toEqual({
      home: "asset:b.png",
      user: "asset:u.png",
    });
  });
  it("删掉一条只剩另一条；空名字与空格地址都算缺项", () => {
    expect(iconOverrideRemoved({ home: "a", user: "b" }, "home")).toEqual({
      user: "b",
    });
    expect(iconMissingFields({ name: "", ref: "  " })).toHaveLength(2);
    expect(iconMissingFields({ name: "home", ref: " asset:a.png " })).toEqual([]);
  });
  it("新增时挑第一个没被覆盖过的图标", () => {
    expect(firstUnusedIconName(["home", "user"], { home: "asset:a.png" })).toBe(
      "user",
    );
    expect(firstUnusedIconName(["home"], { home: "asset:a.png" })).toBe("");
  });
  it("摘要：能显示的给地址，脏引用说清不是可显示地址，超长截住", () => {
    expect(iconOverrideSummary("asset:封面.png")).toBe(
      "/api/theme-asset/%E5%B0%81%E9%9D%A2.png",
    );
    expect(iconOverrideSummary("https://a.b/c.png")).toBe("https://a.b/c.png");
    expect(iconOverrideSummary("")).toBe("没有图片地址");
    expect(iconOverrideSummary("   ")).toBe("没有图片地址");
    expect(iconOverrideSummary("javascript:alert(1)")).toContain(
      "不是可显示的图片地址",
    );
    const long = `https://a.b/${"x".repeat(120)}`;
    expect(iconOverrideSummary(long).length).toBeLessThanOrEqual(61);
    expect(iconOverrideSummary(long).endsWith("…")).toBe(true);
  });
});

describe("自定义主题存档", () => {
  it("名字纯空格算没填，报的是「起名」这一句", () => {
    expect(archiveMissingFields({ name: "   " })).toEqual([
      { field: "name", message: "给这套配置起个名字（如「青花瓷」）" },
    ]);
    expect(archiveMissingFields({ name: " 青花瓷 " })).toEqual([]);
  });
  it("大小：0 也说 1KB，过 1MB 换单位并留一位小数", () => {
    expect(humanBytes(0)).toBe("1KB");
    expect(humanBytes(1024)).toBe("1KB");
    expect(humanBytes(1024 * 1024)).toBe("1.0MB");
    expect(humanBytes(3.5 * 1024 * 1024)).toBe("3.5MB");
    expect(humanBytes(1536)).toBe("2KB");
  });
  it("行摘要末段是大小，空清单里的一份包也说得出大小", () => {
    const s = themeSetSummary({ created: 1700000000000, bytes: 0 });
    expect(s.endsWith(" · 1KB")).toBe(true);
    expect(s.length).toBeGreaterThan(" · 1KB".length);
  });
});

describe("个人信息弹页", () => {
  it("提交前 trim 再按各自上限收", () => {
    const d = identityDraftOf("  阿辙  ", "  ".repeat(1) + "一句话".repeat(60));
    const p = identityPayloadOf(d);
    expect(p.guestName).toBe("阿辙");
    expect(p.adminBio.length).toBe(IDENTITY_BIO_MAX);
    expect(identityPayloadOf(identityDraftOf("a", "b")).guestName).toBe("a");
  });
  it("称呼填得再长，交出去也只有 20 字", () => {
    expect(identityPayloadOf(identityDraftOf("长".repeat(50), "")).guestName)
      .toBe("长".repeat(IDENTITY_NAME_MAX));
  });
  it("空着的格子说清是「没填」", () => {
    expect(identityNameTitle("  ")).toBe("称呼还没填");
    expect(identityNameTitle(" 阿辙 ")).toBe("阿辙");
    expect(identityBioSummary("").startsWith("还没写签名")).toBe(true);
    expect(identityBioSummary("一句话")).toBe("签名「一句话」");
  });
  it("摘句把换行压成空格，超长补省略号", () => {
    expect(snippet("第一行\n第二行")).toBe("第一行 第二行");
    expect(snippet("abc", 2)).toBe("ab…");
    expect(snippet("", 2)).toBe("");
  });
});

describe("壁纸行摘要：src 的三种来源各有各的说法", () => {
  it("空 src（连空格都算空）：说没铺，并说清退回到哪张", () => {
    expect(backgroundSourceKind("")).toBe("none");
    expect(backgroundSourceKind("   ")).toBe("none");
    expect(backgroundSourceSummary("", "chat")).toBe("没铺，退回全局那张");
    expect(backgroundSourceSummary("  ", "settings")).toBe("没铺，退回全局那张");
    // 全局那一格没铺是退无可退，不能跟着说「退回全局那张」
    expect(backgroundSourceSummary("", "global")).toBe("没铺，各界面退回出厂纸底");
  });
  it("asset: 前缀算云盘，名字不合法就说铺不出来", () => {
    expect(backgroundSourceKind("asset:封面.png")).toBe("asset");
    expect(backgroundSourceSummary("asset:封面.png", "chat")).toBe(
      "云盘 asset:封面.png",
    );
    expect(backgroundSourceSummary(" asset:封面.png ", "chat")).toBe(
      "云盘 asset:封面.png",
    );
    expect(backgroundSourceSummary("asset:a/b.png", "chat")).toContain("不合法");
  });
  it("http(s) 外链算「外链」，大小写都认", () => {
    for (const src of ["https://a.b/c.png", "HTTP://a.b/c.png"]) {
      expect(backgroundSourceKind(src)).toBe("link");
      expect(backgroundSourceSummary(src, "gate")).toBe(`外链 ${src}`);
    }
  });
  it("既不是 asset: 也不是 http(s)：原样给出来并说清铺不出来", () => {
    expect(backgroundSourceKind("javascript:alert(1)")).toBe("other");
    expect(backgroundSourceSummary("url(a.png)", "notes")).toContain("铺不出来");
  });
  it("超长地址截住，不把行撑破", () => {
    const s = backgroundSourceSummary(`https://a.b/${"x".repeat(120)}.png`, "chat");
    expect(s.startsWith("外链 ")).toBe(true);
    expect(s.endsWith("…")).toBe(true);
    expect(s.length).toBeLessThanOrEqual("外链 ".length + 48 + 1);
  });
});

describe("壁纸行摘要：位置、压暗与六格枚举", () => {
  it("六格是闭集，每格都得有一行说得出口的摘要", () => {
    expect(BACKGROUND_SCOPES).toEqual([
      "global",
      "chat",
      "notes",
      "settings",
      "gate",
      "login",
    ]);
    const rows = new Map<BackgroundScope, string>(
      BACKGROUND_SCOPES.map((scope) => [
        scope,
        backgroundRowSummary(scope, bgRow({ src: "asset:a.png", dim: 0.2 })),
      ]),
    );
    expect(rows.size).toBe(6);
    for (const scope of BACKGROUND_SCOPES) {
      const s = rows.get(scope) ?? "";
      expect(s).toContain("云盘 asset:a.png");
      expect(s).toContain("位置 center");
      expect(s).toContain("压暗 20%");
    }
    // 铺了图之后六格的说法一致（这时候没铺那句话不再出现）
    expect(rows.get("global")).not.toContain("没铺");
  });
  it("缺一格也照报（草稿被脏数据啃过时不能掉行），行上还是那句话", () => {
    expect(backgroundRowSummary("login", undefined)).toBe(
      "没铺，退回全局那张 · 位置 center · 不压暗",
    );
  });
  it("一行说清铺了什么、怎么铺、压暗多少", () => {
    expect(
      backgroundRowSummary(
        "chat",
        bgRow({ src: "asset:a.png", position: " top ", dim: 0.35 }),
      ),
    ).toBe("云盘 asset:a.png · 位置 top · 压暗 35%");
  });
  it("压暗措辞：0 说不压暗，脏值收进 0~100", () => {
    expect(backgroundDimLabel(0)).toBe("不压暗");
    expect(backgroundDimLabel(0.05)).toBe("压暗 5%");
    expect(backgroundDimLabel(0.45)).toBe("压暗 45%");
    expect(backgroundDimLabel(1)).toBe("压暗 100%");
    expect(backgroundDimLabel(3)).toBe("压暗 100%");
    expect(backgroundDimLabel(-1)).toBe("不压暗");
    expect(backgroundDimLabel(Number.NaN)).toBe("不压暗");
  });
  it("位置归一：多余空白压掉、封顶，空的按 center", () => {
    expect(normalizeBackgroundPosition("  top   left ")).toBe("top left");
    expect(normalizeBackgroundPosition("")).toBe("center");
    expect(normalizeBackgroundPosition("\n ")).toBe("center");
    expect(normalizeBackgroundPosition("x".repeat(80))).toHaveLength(
      MAX_BG_POSITION,
    );
  });
  it("尺寸归一：空的按 cover，三档之外的写法只 trim 不改写", () => {
    expect(normalizeBackgroundSize("")).toBe("cover");
    expect(normalizeBackgroundSize(" contain ")).toBe("contain");
    expect(normalizeBackgroundSize(" 100% 100% ")).toBe("100% 100%");
  });
  it("尺寸下拉：三档之外的存量值也列一条，免得点保存就弄丢了", () => {
    expect(backgroundSizeChoices("cover").map((o) => o.value)).toEqual([
      "cover",
      "contain",
      "auto",
    ]);
    const choices = backgroundSizeChoices("100% 100%");
    expect(choices.map((o) => o.value)).toEqual([
      "cover",
      "contain",
      "auto",
      "100% 100%",
    ]);
    expect(choices[3].label).toContain("自定义");
    expect(backgroundSizeChoices("").map((o) => o.value)).toEqual([
      "cover",
      "contain",
      "auto",
    ]);
  });
});

describe("壁纸弹页：按下保存交出去的那一格", () => {
  it("开窗快照原样进框，归一留到按下保存那一步", () => {
    expect(
      backgroundDraftOf(bgRow({ src: " asset:a.png ", position: " top " })),
    ).toEqual({ src: " asset:a.png ", position: " top ", size: "cover" });
    expect(backgroundDraftOf(undefined)).toEqual({
      src: "",
      position: "",
      size: "",
    });
  });
  it("换图 trim、位置尺寸归一，压暗与模糊原样带走（那是行上调出来的）", () => {
    const next = backgroundWithDraft(
      bgRow({
        src: "asset:old.png",
        dim: 0.4,
        blur: 12,
        position: "center",
        size: "cover",
      }),
      { src: " https://a.b/new.png ", position: "  top  left ", size: "" },
    );
    expect(next.src).toBe("https://a.b/new.png");
    expect(next.position).toBe("top left");
    expect(next.size).toBe("cover");
    expect(next.dim).toBe(0.4);
    expect(next.blur).toBe(12);
  });
  it("这一格本来就缺时五个字段都得齐（后端认的是整格形状）", () => {
    expect(
      backgroundWithDraft(undefined, {
        src: " asset:a.png ",
        position: "",
        size: "",
      }),
    ).toEqual({
      src: "asset:a.png",
      dim: 0,
      blur: 0,
      position: "center",
      size: "cover",
    });
  });
});

describe("功能块底色与按钮花纹（一域两格）", () => {
  it("底色照字说：那是整段 CSS 值，不是素材引用", () => {
    expect(panelBgSummary("")).toBe("出厂底色（功能块没改过背景）");
    expect(panelBgSummary("   ")).toBe("出厂底色（功能块没改过背景）");
    expect(panelBgSummary("#f7f4ec")).toBe("铺的是「#f7f4ec」");
    expect(
      panelBgSummary(`url("${"x".repeat(120)}")`).endsWith("…」"),
    ).toBe(true);
  });
  it("花纹：没铺说没铺；手写 url(...) 点破会被丢掉，脏引用说不是纯引用", () => {
    expect(buttonPatternSummary("")).toBe("没铺花纹，按钮只有底色");
    expect(buttonPatternSummary("https://a.b/p.png")).toBe(
      "花纹 https://a.b/p.png",
    );
    expect(buttonPatternSummary("url(a.png)")).toContain(
      "包一层 url(...) 会被丢掉",
    );
    expect(buttonPatternSummary("javascript:alert(1)")).toContain(
      "不是 asset:/https 引用",
    );
  });
  it("整域提交：空花纹发 null 才清得掉，空底色照原样发（口径与改造前一致）", () => {
    expect(panelStylePatchOf({ panelBg: "", buttonPattern: "" })).toEqual({
      panelBg: "",
      buttonPattern: null,
    });
    expect(
      panelStylePatchOf({ panelBg: "#eee", buttonPattern: "asset:p.png" }),
    ).toEqual({ panelBg: "#eee", buttonPattern: "asset:p.png" });
  });
});
