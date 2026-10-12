import { useEffect, useState } from "react";
import { api } from "../lib/api";
import type { MatrixStat } from "../lib/types";
import { Icon } from "./Icons";

/**
 * 设置页里的网页矩阵状态卡。
 *
 * 完整的管理界面搬去了独立整页工作台（/assistant/workbench）—— 矩阵的图谱、
 * 房间视角、页面预览需要一个整页才铺得开，塞在设置抽屉里只会被压扁。
 * 这里只留一眼看得完的状态：什么版本、矩阵多大、进工作台的门。
 */
const WORKBENCH_PATH = "/assistant/workbench";

/** 按钮形态的中文名：注入物的壳长什么样 */
const SHAPE_LABEL: Record<MatrixStat["theme"]["button"], string> = {
  text: "文字链接",
  outline: "描边",
  solid: "实底",
};

export function MatrixStatus() {
  const [stat, setStat] = useState<MatrixStat | null>(null);
  const [err, setErr] = useState("");

  useEffect(() => {
    let alive = true;
    api
      .matrixStat()
      .then((s) => {
        if (alive) setStat(s);
      })
      .catch((e) => {
        if (alive) setErr((e as Error).message);
      });
    return () => {
      alive = false;
    };
  }, []);

  return (
    <div className="panel-body">
      <div className="card-header">
        <h3 className="card-title">网页矩阵</h3>
        <p className="card-desc">
          一批挂在主域名下的自建网页，主包原生的功能。
          它是外挂在接待台之外的工作台，配置面又宽又深 —— 完整的管理界面在单独一页里，
          这儿只看状态与入口。
        </p>
      </div>

      {!stat && !err && <p className="empty-sm">读取中…</p>}
      {err && <p className="err">{err}</p>}

      {stat && (
        <>
          <div className="toggle-list">
            <div className="toggle-row">
              <div className="toggle-info">
                <div className="toggle-icon">
                  <Icon name="link" size={17} />
                </div>
                <div className="toggle-text">
                  <div className="toggle-title">
                    网页矩阵在线 · v{stat.version || __APP_VERSION__}
                  </div>
                  <div className="toggle-desc">
                    构建 {stat.build || __GIT_HASH__} · 云盘
                    {stat.r2 ? "已连" : "未连"}
                  </div>
                </div>
              </div>
              <a
                className="btn btn-primary btn-sm"
                href={WORKBENCH_PATH}
                target="_blank"
                rel="noopener noreferrer"
              >
                打开工作台
              </a>
            </div>

            <div className="toggle-row">
              <div className="toggle-info">
                <div className="toggle-icon">
                  <Icon name="edit" size={17} />
                </div>
                <div className="toggle-text">
                  <div className="toggle-title">
                    {stat.pages} 节点 · {stat.links} 通路
                  </div>
                  <div className="toggle-desc">
                    入口页 {stat.entries} · 外链页 {stat.external} · 沙箱页{" "}
                    {stat.sandbox} · 配置版本 #{stat.rev}
                  </div>
                </div>
              </div>
            </div>

            <div className="toggle-row">
              <div className="toggle-info">
                <div className="toggle-icon">
                  <Icon name="image" size={17} />
                </div>
                <div className="toggle-text">
                  <div className="toggle-title">注入物外观</div>
                  <div className="toggle-desc">
                    主色 {stat.theme.accent} · 按钮{SHAPE_LABEL[stat.theme.button]}{" "}
                    · 悬浮菜单{stat.nav.on ? "开" : "关"} · 外站认定 {stat.sites} 条
                  </div>
                </div>
              </div>
            </div>
          </div>

          {stat.updatedAt > 0 && (
            <p className="meta">
              最近一次改动：{new Date(stat.updatedAt).toLocaleString()}
            </p>
          )}
        </>
      )}
    </div>
  );
}
