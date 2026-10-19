import { createElement, lazy, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { LoadingBoundary, LoadingStatus, resourceErrorActions } from "./LoadingBoundary";

describe("按需模块的等待反馈", () => {
  it("不等待聊天代码也能呈现可访问的加载说明", () => {
    const html = renderToStaticMarkup(createElement(LoadingStatus, { label: "正在载入接待台", fullscreen: true }));
    expect(html).toContain('role="status"');
    expect(html).toContain("正在载入接待台");
  });
  it("模块未到时只阻塞自己的区域，父框架仍在", () => {
    // 永不完成的导入 = 真实的弱网中间态
    const Pending = lazy(() => new Promise<{ default: () => null }>(() => {}));
    const pending: ReactElement = createElement(Pending);
    const html = renderToStaticMarkup(
      createElement(
        "main",
        null,
        "聊天框架",
        createElement(LoadingBoundary, { label: "正在载入消息" }, pending),
      ),
    );
    expect(html).toContain("聊天框架");
    expect(html).toContain("正在载入消息");
    // 区域自己 pending，不代表父层被换成加载态：聊天框架那一行必须还在原位
    expect(html).not.toContain("暂时未能加载");
  });
});

describe("模块下载失败的恢复出口", () => {
  it("调用方接了就地重试时，不再要求整页重载", () => {
    const actions = resourceErrorActions(() => {});
    expect(actions.reload).toBe(false);
    expect(actions.label).toBe("重试加载");
    expect(actions.hint).toContain("不必刷新整个页面");
  });
  it("没接重试出口时退回整页重载（默认行为不能因为改造而消失）", () => {
    const actions = resourceErrorActions();
    expect(actions.reload).toBe(true);
    expect(actions.label).toBe("重新加载页面");
    expect(actions.hint).toContain("草稿");
  });
});
