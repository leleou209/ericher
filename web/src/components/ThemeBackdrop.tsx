// 主题壁纸层：把某个背景位（会话 / 笔记本 / 设置 / 门口 …）的图和压暗层铺出来。
//
// 落点只管把这层放进来，自己不用动布局 —— 图层、模糊、压暗全在里头。
// 两种定位，按落点挑：
//   fixed    —— 垫在整页内容底下（z-index:-1），给 Shell 各视图用。视图容器
//               的纸底在 data-wallpaper 命中时会让位（见 styles.css）；
//   absolute —— 塞进自带底色/遮罩的容器里（门口 .gate、介绍页浮层）。fixed
//               会被它们的 background 盖住，贴进它们内部才露得出来。

import type { CSSProperties } from "react";
import {
  backgroundLayerStyles,
  useTheme,
  type BackgroundScope,
} from "../lib/theme";

export function ThemeBackdrop({
  scope,
  variant = "fixed",
}: {
  scope: BackgroundScope;
  variant?: "fixed" | "absolute";
}) {
  const { theme } = useTheme();
  const { image, dim } = backgroundLayerStyles(theme, scope);
  // 没铺图就整层不出场：默认主题该是什么样还是什么样
  if (!image.backgroundImage) return null;

  const base: CSSProperties =
    variant === "fixed"
      ? {
          position: "fixed",
          inset: 0,
          zIndex: -1,
          overflow: "hidden",
          pointerEvents: "none",
        }
      : {
          position: "absolute",
          inset: 0,
          zIndex: 0,
          overflow: "hidden",
          pointerEvents: "none",
        };

  return (
    <div className="theme-backdrop" style={base} aria-hidden="true">
      <div style={image as unknown as CSSProperties} />
      <div style={dim as unknown as CSSProperties} />
    </div>
  );
}
