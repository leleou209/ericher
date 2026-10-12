import { describe, expect, it } from "vitest";
import {
  assertInScope,
  canReadFile,
  fileResponseHeaders,
  roomKeyPrefix,
  roomKeyPrefixes,
  safeFolder,
  safeKeyPath,
  scopedKey,
  SESSION_FOLDER,
  sessionKey,
  THEME_PACK_FOLDER,
  themePackKey,
} from "../src/fileAccess";

describe("房间文件划界", () => {
  it("管理员全库可见：带前缀的、老的无前缀 key 都能读", () => {
    expect(canReadFile("f/default/draw-1-a.png", "admin", "default")).toBe(
      true,
    );
    expect(canReadFile("draw-1730000000000.png", "admin", "default")).toBe(
      true,
    );
    // 管理员连来客房间的图也能看（面板排查用）
    expect(canReadFile("f/guest-ab12/draw-1-x.png", "admin", "default")).toBe(
      true,
    );
  });

  it("来客只读自己房间前缀下的", () => {
    expect(canReadFile("f/guest-ab12/draw-1-x.png", "user", "guest-ab12")).toBe(
      true,
    );
  });

  it("来客也读得到自己名下场屋的产物：key 前缀是「人屋--场id」", () => {
    // 在场屋里画出来的图，key 用的是场屋名，而 REST 那侧只能算到人屋 ——
    // 不认这一层，来客自己场屋里生成的图，他自己打开的是一张破图
    expect(
      canReadFile(
        "f/guest-ab12--s-9/会话/s-9/draw-1.png",
        "user",
        "guest-ab12",
      ),
    ).toBe(true);
    // 反过来也放行：场屋里的工具拿 ctx.room（场屋名）去读人屋本尊的产物，是同一个人的
    expect(
      canReadFile("f/guest-ab12/draw-1.png", "user", "guest-ab12--s-9"),
    ).toBe(true);
    // 别人名下的场屋一概不行；相似人屋名也不误撞
    expect(
      canReadFile("f/guest-cccc--s-9/draw-1.png", "user", "guest-ab12"),
    ).toBe(false);
    expect(
      canReadFile("f/guest-ab123--s-9/draw-1.png", "user", "guest-ab12"),
    ).toBe(false);
  });

  it("别人的房间、老的无前缀 key、_admin 混进来的 role，都拒", () => {
    expect(canReadFile("f/default/draw-1-a.png", "user", "guest-ab12")).toBe(
      false,
    );
    expect(canReadFile("f/guest-cccc/draw-1-x.png", "user", "guest-ab12")).toBe(
      false,
    );
    // 前缀约定之前的存量图：来客本来就看不了，维持不可见
    expect(canReadFile("draw-1730000000000.png", "user", "guest-ab12")).toBe(
      false,
    );
  });

  it("相似房间名不误撞：guest-ab 的前缀匹配不到 guest-ab12 的文件", () => {
    // 关键在 roomKeyPrefix 的尾斜杠：f/guest-ab/ 不是 f/guest-ab12/ 的前缀
    expect(canReadFile("f/guest-ab12/draw-1-x.png", "user", "guest-ab")).toBe(
      false,
    );
    expect(roomKeyPrefix("guest-ab")).toBe("f/guest-ab/");
  });

  it("编过码的 key 也能判（%2F 解码成 / 之后形状一致）", () => {
    expect(
      canReadFile("f%2Fguest-ab12%2Fdraw-1-x.png", "user", "guest-ab12"),
    ).toBe(false); // 未解码时拒 —— 调用方必须先解码再判（handleServe 的做法）
  });

  it("公开空间 f/public/ 谁都读得到：不挑角色也不挑房间", () => {
    // 别的房间的来客、任何持卡者 —— 公开就是给进门的人看的
    expect(canReadFile("f/public/poster-1-a.png", "user", "guest-ab12")).toBe(
      true,
    );
    expect(canReadFile("f/public/poster-1-a.png", "user", "guest-cccc")).toBe(
      true,
    );
    expect(canReadFile("f/public/poster-1-a.png", "admin", "default")).toBe(
      true,
    );
    // scopedKey("public") 生成的 key 正好落进公开前缀（上传公开文件的路）
    expect(scopedKey("public", "poster", "png")).toMatch(
      /^f\/public\/poster-\d{13}-[0-9a-f]{8}\.png$/,
    );
  });
});

describe("scopedKey 生成", () => {
  it("带房间前缀、时间戳、随机段和扩展名；两次生成不相重", () => {
    const a = scopedKey("default", "draw", "png");
    const b = scopedKey("default", "draw", "png");
    expect(a).toMatch(/^f\/default\/draw-\d{13}-[0-9a-f]{8}\.png$/);
    expect(b).toMatch(/^f\/default\/draw-\d{13}-[0-9a-f]{8}\.png$/);
    expect(a).not.toBe(b);
    expect(scopedKey("guest-ab12", "diagram", "svg")).toMatch(
      /^f\/guest-ab12\/diagram-\d{13}-[0-9a-f]{8}\.svg$/,
    );
  });
});

describe("sessionKey 会话归档", () => {
  it("有会话就落进 会话/<id>/ 文件夹，房间划界照旧", () => {
    expect(sessionKey("default", "s-123", "draw", "png")).toMatch(
      new RegExp(
        `^f\\/default\\/${SESSION_FOLDER}\\/s-123\\/draw-\\d{13}-[0-9a-f]{8}\\.png$`,
      ),
    );
    // 来客房的产物也归档在自己那间之下，读取划界（canReadFile）不用改
    const k = sessionKey("guest-ab12", "s-9", "diagram", "mmd");
    expect(k.startsWith("f/guest-ab12/会话/s-9/")).toBe(true);
    expect(canReadFile(k, "user", "guest-ab12")).toBe(true);
    expect(canReadFile(k, "user", "guest-cccc")).toBe(false);
  });

  it("没有会话退回旧路：根目录直落，行为与改造前一字不差", () => {
    expect(sessionKey("default", undefined, "draw", "png")).toMatch(
      /^f\/default\/draw-\d{13}-[0-9a-f]{8}\.png$/,
    );
    expect(sessionKey("default", "", "draw", "png")).toMatch(
      /^f\/default\/draw-\d{13}-[0-9a-f]{8}\.png$/,
    );
  });
});

describe("themePackKey 美化包归档", () => {
  it("落进公开空间的 betpag 文件夹，名字洗净、尾缀恒为 .zip", () => {
    expect(themePackKey("青瓷主题.zip")).toMatch(
      new RegExp(
        `^f\\/public\\/${THEME_PACK_FOLDER}\\/青瓷主题-\\d{13}-[0-9a-f]{8}\\.zip$`,
      ),
    );
    // 路径分隔符和非法字符都换掉，不给归档 key 长出脚来的机会
    expect(themePackKey('a/b\\c:x.zip')).toMatch(
      new RegExp(
        `^f\\/public\\/${THEME_PACK_FOLDER}\\/a_b_c_x-\\d{13}-[0-9a-f]{8}\\.zip$`,
      ),
    );
  });

  it("归档的包人人读得：皮肤全局可见，包也一样", () => {
    const k = themePackKey("ericher-theme.zip");
    expect(canReadFile(k, "admin", "default")).toBe(true);
    expect(canReadFile(k, "user", "guest-ab12")).toBe(true);
    expect(k.startsWith(`f/public/${THEME_PACK_FOLDER}/`)).toBe(true);
  });

  it("没名字就叫 ericher-theme，同名传两次是两份、都留着", () => {
    const a = themePackKey("");
    const b = themePackKey("ericher-theme.zip");
    for (const k of [a, b])
      expect(k).toMatch(
        new RegExp(
          `^f\\/public\\/${THEME_PACK_FOLDER}\\/ericher-theme-\\d{13}-[0-9a-f]{8}\\.zip$`,
        ),
      );
    // 随机段兜底：同一毫秒连传两份也不会互相覆盖
    expect(a).not.toBe(b);
  });
});

describe("safeFolder 路径洗净", () => {
  it("正常路径原样收下：多余斜杠和首尾空白都抹平", () => {
    expect(safeFolder("通用")).toBe("通用");
    expect(safeFolder("/个人/合同/")).toBe("个人/合同");
    expect(safeFolder("  a / b  ")).toBe("a/b");
    expect(safeFolder("")).toBe("");
  });

  it("不合法的一律抛错：上跳、当前段、控制字符、分隔符、超深、超长", () => {
    expect(() => safeFolder("../别人家")).toThrow();
    expect(() => safeFolder("a/..")).toThrow();
    expect(() => safeFolder("a/./b")).toThrow();
    expect(() => safeFolder("a\\b")).toThrow();
    expect(() => safeFolder("a\u0000b")).toThrow();
    expect(() => safeFolder("a/b/c/d/e/f/g")).toThrow(); // 默认最多 6 层
    expect(() => safeFolder(`${"长".repeat(81)}`)).toThrow();
  });

  it("中文和常见符号段是合法的：会话、备注（2026）都收", () => {
    expect(safeFolder("会话/s-123/备注（2026）")).toBe(
      "会话/s-123/备注（2026）",
    );
  });
});

describe("safeKeyPath 整条路径洗净", () => {
  it("正常的 key 原样收下：房间前缀、子目录、文件名都保留", () => {
    expect(safeKeyPath("f/default/通用/合同.pdf")).toBe(
      "f/default/通用/合同.pdf",
    );
    expect(safeKeyPath("/f/guest-ab12//会话/s-1/draw-1.png/")).toBe(
      "f/guest-ab12/会话/s-1/draw-1.png",
    );
  });

  it("空路径、上跳、非法字符、超深都拒", () => {
    expect(() => safeKeyPath("")).toThrow();
    expect(() => safeKeyPath("  ")).toThrow();
    expect(() => safeKeyPath("f/a/../b.png")).toThrow();
    expect(() => safeKeyPath("f/a/b\\c.png")).toThrow();
    expect(() => safeKeyPath("a/b/c/d/e/f/g/h/i/j/k/l/m")).toThrow(); // 最多 12 段
  });

  it(".keep 占位段是合法的：它只是个以点开头的普通名字", () => {
    expect(safeKeyPath("f/default/新建文件夹/.keep")).toBe(
      "f/default/新建文件夹/.keep",
    );
  });
});

describe("assertInScope 范围划界", () => {
  it("来客：房间前缀内的放行，别人的房间和公开空间都拒", () => {
    const scope = roomKeyPrefix("guest-ab12");
    expect(() =>
      assertInScope("f/guest-ab12/会话/s-1/draw.png", scope),
    ).not.toThrow();
    expect(() => assertInScope("f/guest-cccc/x.png", scope)).toThrow();
    expect(() => assertInScope("f/public/poster.png", scope)).toThrow();
  });

  it("管理员 scope 为空串：整只桶都放行", () => {
    expect(() => assertInScope("f/guest-cccc/x.png", "")).not.toThrow();
    expect(() => assertInScope("旧文件.png", "")).not.toThrow();
  });

  it("来客的范围是人屋 + 他名下的场屋：场屋产物删得掉，别人的仍然不行", () => {
    const scope = roomKeyPrefixes("guest-ab12");
    expect(scope).toEqual(["f/guest-ab12/", "f/guest-ab12--"]);
    expect(() =>
      assertInScope("f/guest-ab12--s-9/会话/s-9/draw.png", scope),
    ).not.toThrow();
    expect(() => assertInScope("f/guest-cccc/x.png", scope)).toThrow();
    expect(() => assertInScope("f/guest-ab123--s-9/x.png", scope)).toThrow();
    expect(() => assertInScope("f/public/poster.png", scope)).toThrow();
  });
});

describe("scopedKey 带 folder", () => {
  it("给 folder 就落在房间前缀下的子目录里；不给维持原路", () => {
    expect(scopedKey("default", "合同", "pdf", "个人/2026")).toMatch(
      /^f\/default\/个人\/2026\/合同-\d{13}-[0-9a-f]{8}\.pdf$/,
    );
    expect(scopedKey("default", "draw", "png")).toMatch(
      /^f\/default\/draw-\d{13}-[0-9a-f]{8}\.png$/,
    );
  });
});

describe("云盘响应头：SVG / HTML 是文档，得压进不透明源", () => {
  it("SVG（图纸工具的产物）带 CSP sandbox：单独开窗口也调不了带 cookie 的接口", () => {
    const h = fileResponseHeaders("image/svg+xml");
    expect(h["Content-Security-Policy"]).toContain("sandbox");
    expect(h["Content-Disposition"]).toBe("inline");
    expect(h["x-robots-tag"]).toBe("noindex");
  });

  it("HTML 照旧压 sandbox", () => {
    const h = fileResponseHeaders("text/html; charset=utf-8");
    expect(h["Content-Security-Policy"]).toContain("sandbox");
    expect(h["x-robots-tag"]).toBe("noindex");
  });

  it("带参数的类型和 XHTML 也压 sandbox：判断按去参数的媒体类型来", () => {
    // 上传存的类型可能带着 `; charset=utf-8`，精确匹配会把这一类漏出去
    expect(
      fileResponseHeaders("image/svg+xml; charset=utf-8")[
        "Content-Security-Policy"
      ],
    ).toContain("sandbox");
    expect(
      fileResponseHeaders("application/xhtml+xml")["Content-Security-Policy"],
    ).toContain("sandbox");
    expect(
      fileResponseHeaders("TEXT/HTML; charset=utf-8")[
        "Content-Security-Policy"
      ],
    ).toContain("sandbox");
  });

  it("普通图片内联展示但绝不 sandbox（img 标签要能画）", () => {
    const h = fileResponseHeaders("image/png");
    expect(h["Content-Disposition"]).toBe("inline");
    expect(h["Content-Security-Policy"]).toBeUndefined();
    expect(h["x-robots-tag"]).toBe("noindex");
  });

  it("私有文件无论类型都不缓存，切换身份后必须重新鉴权", () => {
    const pdf = fileResponseHeaders("application/pdf");
    const image = fileResponseHeaders("image/png");
    expect(pdf["Content-Type"]).toBe("application/pdf");
    expect(pdf["Cache-Control"]).toBe("private, no-store");
    expect(image["Cache-Control"]).toBe("private, no-store");
    expect(pdf["Content-Security-Policy"]).toBeUndefined();
    expect(pdf["Content-Disposition"]).toBeUndefined();
  });

  it("只有公开空间的文件可使用公共缓存，文档仍受 sandbox 保护", () => {
    expect(fileResponseHeaders("image/png", true)["Cache-Control"]).toBe(
      "public, max-age=86400, immutable",
    );
    const html = fileResponseHeaders("text/html", true);
    expect(html["Content-Security-Policy"]).toContain("sandbox");
  });
});
