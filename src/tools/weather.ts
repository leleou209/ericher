// 天气：沿用 wttr.in 的纯文本接口（无 key、无依赖）。

import { tool } from "ai";
import { z } from "zod";

// 自己拼一行，不用 format=4 的预设：预设自带城市名（和我们的 📍 前缀重复）、
// 又只有天气和气温，体感、湿度全丢了 —— 那两样才是「今天出门穿什么」的依据。
const FIELDS = "%c|%t|%f|%h|%w";

export function weatherTools() {
  return {
    weather: tool({
      description: "查询某个城市的实时天气。",
      inputSchema: z.object({
        city: z.string().describe("城市名，中文或英文均可"),
      }),
      execute: async ({ city }) => {
        const r = await fetch(
          `https://wttr.in/${encodeURIComponent(city)}?format=${FIELDS}&m&lang=zh`,
        );
        if (!r.ok) return `天气查询失败：HTTP ${r.status}`;
        const text = (await r.text()).trim();
        if (!text) return `查不到「${city}」的天气。`;
        // 服务端按 | 分列返回，可能给得比要的少（城市认不出时整行是提示文字）
        const [cond, temp, feels, humid, wind] = text
          .split("|")
          .map((s) => s.trim());
        const head = [cond, temp].filter(Boolean).join(" ");
        const bits = [head || text];
        if (feels) bits.push(`体感 ${feels}`);
        if (humid) bits.push(`湿度 ${humid}`);
        if (wind) bits.push(`风 ${wind}`);
        return `📍 ${city}：${bits.filter(Boolean).join(" · ")}`;
      },
    }),
  };
}
