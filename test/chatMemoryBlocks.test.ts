import { describe, expect, it } from "vitest";
import type { MemEntry } from "../src/agent/state";
import {
  chatMemoryBlocks,
  type ChatMemorySource,
} from "../src/shared/chatMemoryBlocks";

const entry = (content: string): MemEntry => ({ content } as MemEntry);

/** 记下每条取数路有没有被走过 —— 权限判定错最常见就是"多走了一条路" */
function recorder(over: Partial<ChatMemorySource> = {}) {
  const called: string[] = [];
  const source: ChatMemorySource = {
    doubts: () => {
      called.push("doubts");
      return "疑问：他上周说的项目还在做吗";
    },
    guestLines: async () => {
      called.push("guestLines");
      return ["管理员公开的：接口周五上线"];
    },
    local: async () => {
      called.push("local");
      return [entry("本间存底：他偏好邮件联系")];
    },
    merged: async () => {
      called.push("merged");
      return [entry("主屋记忆：Q3 目标是续约")];
    },
    hitLines: (hits) => hits.map((h) => `- ${h.content}`),
    ...over,
  };
  return { source, called };
}

describe("chatMemoryBlocks", () => {
  it("档位关掉记忆的来客：三个块全空，且一条取数路都不走", async () => {
    const { source, called } = recorder();
    const blocks = await chatMemoryBlocks(source, "我上次说的项目", true, false);
    expect(blocks).toEqual({ memoryBlock: "", doubtBlock: "", publicBlock: "" });
    expect(called).toEqual([]);
  });

  it("关记忆的来客不能靠合并检索读到长期记忆库", async () => {
    // 这条专抓分支反转：允许判定若写成 else 兜底，就会从这里翻出整库记忆
    const { source } = recorder();
    const blocks = await chatMemoryBlocks(source, "随便问点什么", true, false);
    expect(blocks.memoryBlock).toBe("");
  });

  it("空正文不检索：一轮没有用户话时不该打 Vectorize", async () => {
    const { source, called } = recorder();
    expect(await chatMemoryBlocks(source, "", false, true)).toEqual({
      memoryBlock: "",
      doubtBlock: "",
      publicBlock: "",
    });
    expect(called).toEqual([]);
  });

  it("主人这边只填 memoryBlock，不碰来客那两条路", async () => {
    const { source, called } = recorder();
    const blocks = await chatMemoryBlocks(source, "Q3", false, true);
    expect(blocks.memoryBlock).toContain("## 相关记忆（检索自长期记忆库）");
    expect(blocks.memoryBlock).toContain("主屋记忆");
    expect(blocks.publicBlock).toBe("");
    expect(called).toEqual(["doubts", "merged"]);
  });

  it("放行记忆的来客只走受限读，绝不走合并检索", async () => {
    const { source, called } = recorder();
    const blocks = await chatMemoryBlocks(source, "接口", true, true);
    expect(blocks.publicBlock).toContain("## 记忆库里翻到的（管理员公开的 + 这位客人名下的）");
    expect(blocks.memoryBlock).toBe("");
    expect(called).toEqual(["doubts", "guestLines"]);
  });

  it("主人那间没醒时退回本间存底", async () => {
    const { source, called } = recorder({
      guestLines: async () => {
        called.push("guestLines");
        throw new Error("主屋没醒");
      },
    });
    const blocks = await chatMemoryBlocks(source, "偏好", true, true);
    expect(blocks.publicBlock).toContain("本间存底");
    expect(called).toEqual(["doubts", "guestLines", "local"]);
  });

  it("受限读到空也补一次本间存底", async () => {
    const { source, called } = recorder({
      guestLines: async () => {
        called.push("guestLines");
        return [];
      },
    });
    expect((await chatMemoryBlocks(source, "偏好", true, true)).publicBlock).toContain("本间存底");
    expect(called).toContain("local");
  });

  it("两条读路都失败也只是不注入，不把这一轮说不了话", async () => {
    const { source } = recorder({
      guestLines: async () => {
        throw new Error("主屋没醒");
      },
      local: async () => {
        throw new Error("本地表还没建");
      },
    });
    const blocks = await chatMemoryBlocks(source, "偏好", true, true);
    expect(blocks.publicBlock).toBe("");
    expect(blocks.memoryBlock).toBe("");
  });

  it("疑问块出毛病不拖累记忆注入", async () => {
    const { source } = recorder({
      doubts: () => {
        throw new Error("conflicts 表缺列");
      },
    });
    const blocks = await chatMemoryBlocks(source, "Q3", false, true);
    expect(blocks.doubtBlock).toBe("");
    expect(blocks.memoryBlock).toContain("主屋记忆");
  });

  it("合并检索失败时不抛，只留空块", async () => {
    const { source } = recorder({
      merged: async () => {
        throw new Error("Vectorize 超时");
      },
    });
    expect((await chatMemoryBlocks(source, "Q3", false, true)).memoryBlock).toBe("");
  });
});
