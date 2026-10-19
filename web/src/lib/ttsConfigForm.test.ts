import { describe, expect, it } from "vitest";
import { TTS_DEFAULTS, voiceLabel } from "./presets";
import {
  blankTtsDraft,
  freshTtsDraft,
  ttsDraftOf,
  ttsMissingFields,
  ttsPayloadOf,
  ttsSummary,
  ttsWithProtocol,
} from "./ttsConfigForm";
import type { TtsConfig, TtsProtocol } from "./types";

const filled = { name: "冰糖嗓子", keySecret: "MIMO_API_KEY", model: "mimo-v2.5-tts" };

const cfg = (over: Partial<TtsConfig> = {}): TtsConfig => ({
  id: "a1b2",
  name: "MiMo 主嗓子",
  protocol: "mimo-chat",
  baseUrl: "https://api.xiaomimimo.com/v1/chat/completions",
  keySecret: "MIMO_API_KEY",
  model: "mimo-v2.5-tts",
  voice: "冰糖",
  style: "温柔",
  ...over,
});

describe("必填校验报的是缺哪几项", () => {
  it("三格全空按表单顺序给出各自的提示", () => {
    const missing = ttsMissingFields({ name: "", keySecret: "", model: "" });
    expect(missing.map((m) => m.field)).toEqual(["name", "keySecret", "model"]);
    expect(missing.map((m) => m.message)).toEqual([
      "请填写嗓子名称",
      "请填写 Key 变量名",
      "请填写模型名",
    ]);
  });
  it("纯空格算没填：手滑留下的空格不是值", () => {
    expect(ttsMissingFields({ name: "  ", keySecret: "\n", model: "\t " })).toHaveLength(3);
    expect(ttsMissingFields({ ...filled, keySecret: " " }).map((m) => m.field)).toEqual([
      "keySecret",
    ]);
  });
  it("填齐了就没有缺项；Base URL 与音色留空不拦（各有默认档）", () => {
    expect(ttsMissingFields(filled)).toEqual([]);
  });
});

describe("协议默认值的联动", () => {
  it("空白起头带出 MiMo 一家的默认地址、Key 变量名与模型", () => {
    const d = freshTtsDraft();
    expect(blankTtsDraft().name).toBe("");
    expect(d.protocol).toBe("mimo-chat");
    expect(d.baseUrl).toBe(TTS_DEFAULTS["mimo-chat"].baseUrl);
    expect(d.keySecret).toBe(TTS_DEFAULTS["mimo-chat"].keySecret);
    expect(d.model).toBe(TTS_DEFAULTS["mimo-chat"].model);
  });
  it("没动过的格子跟着换到新协议的默认值", () => {
    const d = ttsWithProtocol(freshTtsDraft(), "doubao");
    expect(d.baseUrl).toBe(TTS_DEFAULTS.doubao.baseUrl);
    expect(d.keySecret).toBe(TTS_DEFAULTS.doubao.keySecret);
    expect(d.model).toBe(TTS_DEFAULTS.doubao.model);
    expect(d.name).toBe("");
  });
  it("手填过的格子留住不洗，停在旧默认值上的算没动过", () => {
    const hand = { ...freshTtsDraft(), baseUrl: "https://my-proxy.example/v1" };
    const next = ttsWithProtocol(hand, "glm-speech");
    expect(next.baseUrl).toBe("https://my-proxy.example/v1");
    expect(next.keySecret).toBe(TTS_DEFAULTS["glm-speech"].keySecret);
    expect(next.model).toBe(TTS_DEFAULTS["glm-speech"].model);
    // 手填过但故意填成别家的默认值：跟「没动过」分不开，按老口径一起换走
    expect(ttsWithProtocol({ ...hand, model: "  " }, "minimax").model).toBe(
      TTS_DEFAULTS.minimax.model,
    );
  });
  it("换协议时名字与语气留在草稿里，style 只在 MiMo 式下有值", () => {
    const d = { ...freshTtsDraft(), name: "试音", style: "清冷" };
    const mimo = ttsWithProtocol(d, "mimo-chat");
    expect(mimo.name).toBe("试音");
    expect(mimo.style).toBe("清冷");
    expect(ttsPayloadOf({ ...mimo, protocol: "minimax" }).style).toBe("");
    expect(ttsPayloadOf(mimo).style).toBe("清冷");
  });
});

describe("草稿与提交口径", () => {
  it("条目回写成草稿是逐格抄，不做任何加工", () => {
    expect(ttsDraftOf(cfg())).toEqual({
      name: "MiMo 主嗓子",
      protocol: "mimo-chat",
      baseUrl: cfg().baseUrl,
      keySecret: "MIMO_API_KEY",
      model: "mimo-v2.5-tts",
      voice: "冰糖",
      style: "温柔",
    });
  });
  it("提交前每格 trim，空 Base URL 就是空串（服务端自己兜底）", () => {
    const p = ttsPayloadOf({
      ...ttsDraftOf(cfg()),
      baseUrl: "  ",
      voice: " 冰糖 ",
      name: " 主嗓子 ",
    });
    expect(p.baseUrl).toBe("");
    expect(p.voice).toBe("冰糖");
    expect(p.name).toBe("主嗓子");
  });
});

describe("列表行摘要", () => {
  it("把协议、模型、音色与 Key 变量名收成一句", () => {
    const s = ttsSummary(cfg());
    expect(s).toContain("MiMo 式对话接口");
    expect(s).toContain("mimo-v2.5-tts");
    // 音色走 presets 的翻名表：断言接线，不复制表里的措辞
    expect(s).toContain(`音色 ${voiceLabel("mimo-chat", "冰糖")}`);
    expect(s).toContain("Key MIMO_API_KEY");
    expect(s.split(" · ")).toHaveLength(4);
  });
  it("没填模型与音色时说默认，不写空", () => {
    const s = ttsSummary(cfg({ model: "", voice: "" }));
    expect(s).toContain("默认模型");
    expect(s).toContain("音色 默认");
  });
  it("后端给了用不上的原因才带上那句原话", () => {
    const s = ttsSummary(cfg({ keySecret: "DOUBAO_TTS_KEY" }), "这台机器没配 DOUBAO_TTS_KEY");
    expect(s.endsWith("这台机器没配 DOUBAO_TTS_KEY")).toBe(true);
    expect(ttsSummary(cfg(), "")).not.toContain("没配");
  });
  it("标签表里没有的协议原样显示，手填的音色 id 照样认", () => {
    const s = ttsSummary(cfg({ protocol: "elevenlabs" as TtsProtocol, voice: "my-voice" }));
    expect(s.split(" · ")[0]).toBe("elevenlabs");
    expect(s).toContain("my-voice");
  });
});
