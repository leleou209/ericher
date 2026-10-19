import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { GateBoundary } from "./GateBoundary";

describe("身份校验的三态呈现", () => {
  const render = (gate: "checking" | "locked" | "open") => renderToStaticMarkup(
    createElement(GateBoundary, { gate, locked: createElement("form", null, "门禁密码") },
      createElement("main", null, "私有会话")),
  );
  it("恢复身份时不闪现门禁，也不展示私有会话", () => {
    const html = render("checking");
    expect(html).toContain("正在恢复会话");
    expect(html).not.toContain("门禁密码");
    expect(html).not.toContain("私有会话");
  });
  it("弱网检查失败时提供重试而非登录表单", () => {
    const html = renderToStaticMarkup(createElement(GateBoundary, {
      gate: "checking", checkError: "网络暂不可用", onRetry: () => {}, locked: createElement("form", null, "门禁密码"),
    }, createElement("main", null, "私有会话")));
    expect(html).toContain("重试身份检查");
    expect(html).not.toContain("门禁密码");
    expect(html).not.toContain("私有会话");
  });
  it("身份检查问不出结果时也给一条进门的路，不把知道口令的人挡死", () => {
    const html = renderToStaticMarkup(createElement(GateBoundary, {
      gate: "checking", checkError: "暂时无法确认登录状态", onRetry: () => {},
      onEnterGate: () => {}, locked: createElement("form", null, "门禁密码"),
    }, createElement("main", null, "私有会话")));
    expect(html).toContain("重试身份检查");
    expect(html).toContain("用门禁码");
    // 入口只是「换到门禁态」的按钮：这一屏仍然既不见门禁表单，也不见私有会话
    expect(html).not.toContain("门禁密码");
    expect(html).not.toContain("私有会话");
  });
  it("没接进门入口时不凭空多一个按钮（调用方没实现就不承诺）", () => {
    const html = renderToStaticMarkup(createElement(GateBoundary, {
      gate: "checking", checkError: "暂时无法确认登录状态", onRetry: () => {},
      locked: createElement("form", null, "门禁密码"),
    }));
    expect(html).not.toContain("用门禁码");
  });
  it("身份失效后才显示门禁", () => {
    expect(render("locked")).toContain("门禁密码");
    expect(render("locked")).not.toContain("私有会话");
  });
  it("校验成功后直接进入私有会话，不显示门禁", () => {
    expect(render("open")).toContain("私有会话");
    expect(render("open")).not.toContain("门禁密码");
  });
});
