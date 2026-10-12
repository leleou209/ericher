/**
 * 画图这条路子上最容易出错的两段纯逻辑。
 *
 * 为什么不测 draw / diagram 本身：那两条要打外部接口、要 R2、要模型配合，
 * 测起来只是在测桩。但这两段不一样 ——
 *   extractMermaid：mermaid 源码是模型写的，它常常包着 ``` 围栏、前后带解释 ——
 *                   得把图源码从话缝里抠出来；
 *   handOff       ：交出去的那行 markdown 是前端认图的唯一依据（Messages.tsx 的 Drawn），
 *                   错一个字符，人就什么图都看不到。
 *   imageKeyIn    ：自检要按那个地址把图从云盘取回来重递一遍 —— 抠错就是「让她看一眼」，
 *                   而她眼前什么都没有。
 *   requestBody   ：图生图的参考图只在 minimax 那档有落点 —— 塞错位置/塞错形状，
 *                   参考图等于没给，「照这张图改」出来的是另一张图。
 * 这几处出错的症状是同一个：「她说画好了，他什么都没看见」，而那最难查。
 *
 * 运行: npx vitest run
 */

import { describe, it, expect } from "vitest";
import {
  extractMermaid,
  handOff,
  imageKeyIn,
  requestBody,
  selfCheck,
  supportsReference,
} from "../src/tools/draw";

describe("extractMermaid", () => {
  it("干净的一段原样取出", () => {
    const src = "flowchart LR\n  a[登录] --> b[首页]";
    expect(extractMermaid(src)).toBe(src);
  });

  it("包在 ```mermaid 围栏里也认得出来", () => {
    const raw =
      "这是源码：\n```mermaid\nflowchart LR\n  a --> b\n```\n就这样。";
    expect(extractMermaid(raw)).toBe("flowchart LR\n  a --> b");
  });

  it("无语言标签的围栏也认（模型常常忘了写 mermaid）", () => {
    const raw = "```\nsequenceDiagram\n  a->>b: hi\n```";
    expect(extractMermaid(raw)).toBe("sequenceDiagram\n  a->>b: hi");
  });

  it("前面带着解释又没围栏，从第一行图型声明取到结尾", () => {
    const raw = "好的，我画了一张：\nflowchart TB\n  a[开工] --> b[收工]";
    expect(extractMermaid(raw)).toBe("flowchart TB\n  a[开工] --> b[收工]");
  });

  it("首行是 %% 注释时跳过注释找图头", () => {
    const src = "%% 画一张登录流程\nflowchart LR\n  a --> b";
    expect(extractMermaid(src)).toBe(src);
  });

  it("首行不是图型声明就不收（收进来前端也渲不出）", () => {
    expect(extractMermaid("我画不了这个。")).toBeNull();
    expect(extractMermaid("流程是这样：a → b → c，大概是吧。")).toBeNull();
  });

  it("空串不收", () => {
    expect(extractMermaid("")).toBeNull();
  });
});

describe("handOff（交出去的那几句话）", () => {
  const url = "/api/files/f/default/diagram-1730000000000-abc123.mmd";

  it("正文里那行是前端认得出的 markdown", () => {
    const out = handOff(
      `图已经画好了：${url}`,
      "登录流程",
      url,
      "SVG 示意 · 2KB",
      "",
    );
    expect(out).toContain(`![登录流程](${url})`);
  });

  it("替换文字里的方括号被剔掉 —— 它会把那行 markdown 拆散，人就看不到图", () => {
    const out = handOff("x", "图[1]", url, "m", "");
    expect(out).toContain(`![图1](${url})`);
    expect(out).not.toContain("![图[1]]");
  });

  it("交代清楚「原样放进回复」，并把存进记忆那句话说给模型听", () => {
    const out = handOff("x", "t", url, "SVG 示意 · 2KB", "\n已存进记忆 [m1]。");
    expect(out).toContain("原样放进你的回复");
    expect(out).toContain("已存进记忆 [m1]。");
  });
});

describe("画完自检（图递回去让她自己看一眼）", () => {
  it("第一版鼓励她看一眼、不对就重画 —— 但只许重画一次", () => {
    expect(selfCheck(1)).toContain("最多一次");
  });

  it("重画过的那一版到此为止：不劝第三次，也不再让她挑自己的毛病", () => {
    expect(selfCheck(2)).toContain("别再画第三版");
    expect(selfCheck(2)).not.toContain("最多一次");
  });

  /**
   * 自检靠 toModelOutput 按地址把图从云盘取回来 —— 地址是从工具结果那段文字里抠出来的。
   * 抠不到，图就递不回去，而她只收到一句「你自己看一眼」，眼前却没有图。
   * 前端 Drawn 用的是同一条正则：三处（handOff 写、这里读、前端渲染）必须对得上。
   */
  it("handOff 写进去的地址，抠得回来（含房间前缀的完整 key）", () => {
    const path = "/api/files/f/default/draw-1730000000000-9f2c1eab.png";
    const out = handOff(
      `画好了：${path}`,
      "一只猫",
      path,
      "FLUX.2 klein · 1024x1024",
      "",
    );
    expect(imageKeyIn(out)).toBe("f/default/draw-1730000000000-9f2c1eab.png");
  });

  it("mermaid 图的 .mmd 地址也抠得回来（前端 Drawn 和这里是同一条正则）", () => {
    const path = "/api/files/f/default/diagram-1730000000000-abc123.mmd";
    const out = handOff(
      `图已经画好了：${path}`,
      "登录流程",
      path,
      "Mermaid 示意 · 5 行",
      "",
    );
    expect(imageKeyIn(out)).toBe("f/default/diagram-1730000000000-abc123.mmd");
  });

  it("没有图的时候（比如没画成）抠出来是空的，别硬凑一个文件名", () => {
    expect(imageKeyIn("这次没画成：\nFLUX：HTTP 500")).toBeNull();
  });
});

describe("图生图（参考图）的请求体", () => {
  const REF = "data:image/png;base64,AAAA";

  it("minimax 带参考图：subject_reference 单图 character —— 官方限一，类型只认 character", () => {
    const b = requestBody("minimax", "image-01", "换个海边的场景", "16:9", REF);
    expect(b).toMatchObject({
      model: "image-01",
      aspect_ratio: "16:9",
      subject_reference: [{ type: "character", image_file: REF }],
    });
  });

  it("minimax 不带参考图：不塞 subject_reference —— 文生图就是文生图", () => {
    const b = requestBody("minimax", "image-01", "画一只猫", "1:1", null);
    expect(b).not.toHaveProperty("subject_reference");
  });

  it("吃不下参考图的档：支持表里只有 minimax，其余给了参考图就跳过那档", () => {
    expect(supportsReference("minimax")).toBe(true);
    for (const f of ["workers-ai", "siliconflow", "zhipu"] as const) {
      expect(supportsReference(f)).toBe(false);
      expect(requestBody(f, "m", "p", "1024x1024", REF)).not.toHaveProperty(
        "subject_reference",
      );
    }
  });
});
