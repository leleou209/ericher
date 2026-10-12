import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { api } from "../lib/api";
import { useDragPos } from "../lib/dragPos";
import { Icon } from "./Icons";
import {
  DiffView,
  HtmlEditor,
  diffLines,
  type DiffLine,
} from "./HtmlEditor";
import { MatrixFlow } from "./MatrixFlow";
import { MatrixPreview } from "./MatrixPreview";
import { MatrixRoom } from "./MatrixRoom";
import type {
  ApprovedSite,
  GuestType,
  LinkPlace,
  MatrixAccess,
  MatrixLink,
  MatrixPage,
  MatrixTheme,
  R2File,
} from "../lib/types";

/**
 * 网页矩阵工作台的舞台。
 *
 * 矩阵页挂在主域名下，是主包原生的功能：按多段层级路径安放
 * （如 thisme/foryou），导航按层级树遍历，每页可选四档身份（公开 / 持票来客 /
 * 管理员 / 指定来客档位），服务端取正文前先验身份，不通过就吐一页零脚本的
 * 「不对你开放」。页面可以是上传的 HTML、云盘里的文件、粘贴的源码或外站链接。
 *
 * 左导航挑一面，右舞台摊开这一面：页面列表、矩阵图谱、页面预览、外观美化、
 * 外站认定、矩阵包。整页工作台（/assistant/workbench）承载这一切。
 */
const ACCESS_LABEL: Record<MatrixAccess, string> = {
  public: "公开",
  visitor: "持票来客",
  admin: "管理员",
  types: "指定档位",
};
/** 正文来源：keep = 编辑旧页时沿用原正文 */
type Source = "keep" | "paste" | "upload" | "drive";

interface Draft {
  id?: string;
  path: string;
  title: string;
  access: MatrixAccess;
  types: string[];
  sandbox: boolean;
  entry: boolean;
  external: string;
  /** 本页自由 CSS（留空 = 不覆盖默认） */
  css: string;
  source: Source;
  text: string;
  file: File | null;
  driveKey: string;
  /** 打开编辑器时取回的原正文：改完要比一比，看动过哪几行 */
  original?: string;
}

function emptyDraft(): Draft {
  return {
    path: "",
    title: "",
    access: "public",
    types: [],
    sandbox: false,
    entry: false,
    external: "",
    css: "",
    source: "paste",
    text: "",
    file: null,
    driveKey: "",
  };
}

function draftOf(p: MatrixPage): Draft {
  return {
    id: p.id,
    path: p.path,
    title: p.title,
    access: p.access,
    types: p.types ?? [],
    sandbox: !!p.sandbox,
    entry: !!p.entry,
    external: p.external ?? "",
    css: p.css ?? "",
    // 引用云盘文件的页面：打开就停在「引用云盘文件」这一档，不动它保存后
    // 仍然跟着那只文件；要改正文就自己换到粘贴/上传（等于把引用断开）
    source: p.driveKey ? "drive" : "keep",
    text: "",
    file: null,
    driveKey: p.driveKey ?? "",
  };
}

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * 新开一间房时的空白正文：保存一页要求新页必须带正文（缺正文直接 400），
 * 所以先给它一张素净的纸，回头去编辑器里换上真正的内容。
 */
function blankPage(title: string): string {
  const t = esc(title || "新房间");
  return (
    `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width,initial-scale=1">` +
    `<title>${t}</title></head>` +
    `<body style="margin:0;min-height:100vh;display:flex;align-items:center;` +
    `justify-content:center;background:#f6f6f7;color:#111;` +
    `font:16px/1.7 system-ui,-apple-system,'Segoe UI',sans-serif;">` +
    `<main style="max-width:420px;padding:28px 32px;background:#fff;` +
    `border:1px solid #e3e3e6;border-radius:14px;text-align:center;">` +
    `<h1 style="margin:0 0 10px;font-size:18px;">${t}</h1>` +
    `<p style="margin:0;color:#555;">这间房还是空的 —— 去编辑器里换上正文。</p>` +
    `</main></body></html>`
  );
}

/** 树里的一支：路径按 / 切段长出来的中间层与叶 */
interface MatrixTreeNode {
  /** 这一段的片段名（如 thisme）—— 树里显示的就是它 */
  name: string;
  /** 到这一段的完整路径，同时用作这一支的唯一键 */
  path: string;
  /** 这一层自己挂着的页面；没有 = 纯文件夹（只是路径的中间段） */
  page?: MatrixPage;
  children: MatrixTreeNode[];
  /** 这一支下面（含自己那一页）一共几页 */
  count: number;
}

/**
 * 把扁平的页面列表按路径拼成树：thisme/foryou、thisme/blog 会自动补出中间层
 * thisme，于是同一个前缀下的页面在面板里收进一个「文件夹」，而不是平铺成
 * 一行行看不出归属的路径。先排序再插，兄弟之间的顺序稳定、可预期。
 */
function buildTree(pages: MatrixPage[]): MatrixTreeNode[] {
  const roots: MatrixTreeNode[] = [];
  const index = new Map<string, MatrixTreeNode>();
  for (const p of [...pages].sort((a, b) => a.path.localeCompare(b.path))) {
    const segs = p.path.split("/").filter(Boolean);
    let level = roots;
    let acc = "";
    segs.forEach((seg, i) => {
      acc = acc ? `${acc}/${seg}` : seg;
      let node = index.get(acc);
      if (!node) {
        node = { name: seg, path: acc, children: [], count: 0 };
        index.set(acc, node);
        level.push(node);
      }
      if (i === segs.length - 1) node.page = p;
      level = node.children;
    });
  }
  tally(roots);
  return roots;
}

/** 自下而上数每一支底下有几页（含自己那一页） */
function tally(list: MatrixTreeNode[]): number {
  let n = 0;
  for (const node of list) {
    node.count = (node.page ? 1 : 0) + tally(node.children);
    n += node.count;
  }
  return n;
}

/**
 * 右栏当前开着哪一面。左导航按这一个值切换视图，一次只摊开一面，
 * 不再把所有东西挤进一条竖轴。
 */
type TabKey = "list" | "graph" | "preview" | "look" | "sites" | "pack";

export function MatrixPanel({
  onBare,
}: {
  /**
   * 「现在该不该只剩舞台」：左导航一收就报 true，工作台顶栏随之退场，整幅高度
   * 都归舞台（预览面尤其需要 —— 那时顶栏不退，页面就铺不满）。顶栏不在这一层
   * 手里（它在 Workbench 上），所以只能把这件事报上去，由外壳去藏。
   */
  onBare?: (bare: boolean) => void;
}) {
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState("");

  const [pages, setPages] = useState<MatrixPage[]>([]);
  const [guestTypes, setGuestTypes] = useState<GuestType[]>([]);
  const [files, setFiles] = useState<R2File[]>([]);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  /** 等确认的正文改动：非 null 就是在等人点头（lines 为 null = 太长，没逐行比） */
  const [pending, setPending] = useState<{ lines: DiffLine[] | null } | null>(
    null,
  );
  /** 收起来的分支（默认全开：矩阵页面通常不多，摊开更好找） */
  const [closed, setClosed] = useState<Set<string>>(new Set());
  /** 全部通路：页面是节点、按钮是边；房间视图与全景图各自挑要显示的边 */
  const [links, setLinks] = useState<MatrixLink[]>([]);
  /** 两个视角：room = 站在某间房里（默认，使用者的视角）；map = 全景图（结构） */
  const [view, setView] = useState<"room" | "map">("room");
  /**
   * 全局悬浮菜单：所有页面统一在左上角挂一个半透明浮窗，列出能去的页面。
   * 全局一个开关（不是每页各设一道）—— 新增页面自动带上。
   */
  const [navOn, setNavOn] = useState(true);
  /** 注入物的长相：主色与按钮形态。跟页面自己的 CSS 是两回事 */
  const [theme, setTheme] = useState<MatrixTheme>({
    accent: "#0b6bcb",
    button: "text",
  });
  /** 外站认定表：列在这儿的域名才允许从内站过去，门卫页据此放行或拦 */
  const [sites, setSites] = useState<ApprovedSite[]>([]);
  /** 脚印：走过的页 id，末位是当前所在。点门、点来路、点面包屑都改它 */
  const [trail, setTrail] = useState<string[]>([]);
  /** 右栏当前开着哪一面：列表 / 图谱 / 预览 / 外观 / 外站 */
  const [tab, setTab] = useState<TabKey>("list");
  /**
   * 是不是手机那种窄屏。
   *
   * 工作台是给大屏做的（左导航 + 右舞台，图谱和预览都拿宽度换出来的），
   * 没打算应付手机 —— 与其把两页挤成一团，不如进去时说一句：
   * 这两面在手机上摊不开，去电脑上开。列表 / 外观 / 外站 / 矩阵包这几面
   * 都是竖着读的，手机上照常用，所以只提醒、不拦。
   */
  const [narrow, setNarrow] = useState(
    () =>
      typeof window !== "undefined" &&
      typeof window.matchMedia === "function" &&
      window.matchMedia("(max-width: 640px)").matches,
  );
  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const mq = window.matchMedia("(max-width: 640px)");
    const on = () => setNarrow(mq.matches);
    on();
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);
  /** 左导航收起没有：收起来就只剩一枚浮标，把整页让给舞台 */
  const [railClosed, setRailClosed] = useState(() => {
    try {
      return localStorage.getItem("matrix:rail:collapsed") === "1";
    } catch {
      return false;
    }
  });
  /** 收起 / 展开左导航，顺手把选择记进本地，下次进来还是这个样子 */
  const setRail = (closed: boolean) => {
    setRailClosed(closed);
    try {
      localStorage.setItem("matrix:rail:collapsed", closed ? "1" : "0");
    } catch {
      /* 隐私模式下写不了就不记 —— 不影响这一会儿的收起展开 */
    }
  };
  /**
   * 预览里的「落点编辑」开着没有：开着才铺可拖的手柄。默认开着 —— 进预览多半
   * 就是来调按钮位置的，只想看页面时在浮标右半边一点就收起来。
   */
  const [edit, setEdit] = useState(true);
  /** 浮标（导航 / 编辑）的落点：拖过记本地，没拖过就按 CSS 钉在左下角 */
  const fab = useDragPos("matrix:workbench:fab");
  /** 装备矩阵包用的文件选择器：按钮点它，选完就走 equipPack */
  const packInput = useRef<HTMLInputElement>(null);

  // 导航一收，舞台就该独占整幅：把顶栏也交给外壳收掉。这一条不只管预览 ——
  // 列表、图谱、外观、外站同理（少一条顶栏，就多一整条内容的高度）
  useEffect(() => {
    onBare?.(railClosed);
  }, [onBare, railClosed]);

  const reload = useCallback(async () => {
    setErr("");
    try {
      // 页面与通路一起取：房间视图要拿两者拼门，全景图要拿两者画边
      const [r, l, s] = await Promise.all([
        api.matrixPages(),
        api.matrixLinks(),
        api.matrixSites(),
      ]);
      setPages(r.pages);
      setLinks(l.links);
      setNavOn(r.nav?.on ?? true);
      if (r.theme) setTheme(r.theme);
      setSites(s.sites);
    } catch (e) {
      setErr((e as Error).message);
    }
  }, []);

  // 首次挂载：拉页面/通路/外站，同时并行取档位白名单与可搬文件（都失败不影响页面列表）
  useEffect(() => {
    let alive = true;
    void reload().finally(() => {
      if (alive) setLoading(false);
    });
    api.guestTypes().then(setGuestTypes).catch(() => {});
    api
      .files()
      .then((r) => setFiles(r.files))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [reload]);

  const tree = useMemo(() => buildTree(pages), [pages]);

  /** 当前站在哪一间 = 脚印的末位 */
  const roomId = trail.length ? trail[trail.length - 1] : "";

  /**
   * 脚印自愈：页面被删、或者第一次进来，都得落在一个站得住的地方 ——
   * 优先入口页，其次第一页；被删掉的中间站顺手抹掉，不会把人留在虚空里。
   */
  useEffect(() => {
    if (pages.length === 0) {
      setTrail((cur) => (cur.length ? [] : cur));
      return;
    }
    const ids = new Set(pages.map((p) => p.id));
    setTrail((cur) => {
      const kept = cur.filter((id) => ids.has(id));
      if (kept.length === cur.length && kept.length) return cur;
      if (kept.length) return kept;
      return [pages.find((p) => p.entry)?.id ?? pages[0].id];
    });
  }, [pages]);

  /** 走到某一间：走过的就截断（像浏览器的历史），没走过的就往前踏一步 */
  const walk = useCallback((id: string) => {
    setTrail((cur) => {
      const i = cur.indexOf(id);
      return i >= 0 ? cur.slice(0, i + 1) : [...cur, id];
    });
  }, []);

  /** 预览里当前这页出边的指纹：一变就让整页重挂一次，取到最新的真实渲染 */
  const linksVersion = useMemo(
    () =>
      links
        .filter((l) => l.from === roomId)
        .map(
          (l) =>
            `${l.from}:${l.to}:${l.label}:${l.order}:${JSON.stringify(l.place)}`,
        )
        .join("|"),
    [links, roomId],
  );

  const toggleFold = (path: string) =>
    setClosed((cur) => {
      const next = new Set(cur);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });

  const openEdit = async (p: MatrixPage) => {
    setMsg("");
    // 编辑器住在列表页里：点开一页就切回列表，免得人在图谱/预览栏里找不到它
    setTab("list");
    setDraft(draftOf(p));
    if (p.external) return;
    try {
      const d = await api.matrixPage(p.id);
      setDraft((cur) =>
        cur && cur.id === p.id
          ? { ...cur, text: d.body, original: d.body, source: "keep" }
          : cur,
      );
    } catch (e) {
      setMsg((e as Error).message);
    }
  };

  const save = async () => {
    if (!draft) return;
    // 正文改过了：先把新旧摆出来比一比，人点了头才落盘
    if (
      draft.id &&
      draft.source === "paste" &&
      draft.text &&
      draft.original !== undefined &&
      draft.text !== draft.original
    ) {
      setPending({ lines: diffLines(draft.original, draft.text) });
      return;
    }
    await commit();
  };

  /** 真正落盘：把草稿打包成一份 FormData 交给保存接口 */
  const commit = async () => {
    if (!draft) return;
    setBusy(true);
    setMsg("");
    try {
      const meta = {
        id: draft.id,
        path: draft.path,
        title: draft.title,
        access: draft.access,
        types: draft.types,
        sandbox: draft.sandbox,
        entry: draft.entry,
        external: draft.external,
        css: draft.css,
      };
      const form = new FormData();
      form.append("meta", JSON.stringify(meta));
      if (!draft.external) {
        if (draft.source === "paste" && draft.text) form.append("text", draft.text);
        else if (draft.source === "upload" && draft.file)
          form.append("file", draft.file);
        else if (draft.source === "drive" && draft.driveKey)
          form.append("key", draft.driveKey);
      }
      await api.matrixSave(form);
      setDraft(null);
      setPending(null);
      await reload();
      setMsg("已保存");
    } catch (e) {
      setMsg((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const remove = async (p: MatrixPage) => {
    if (!window.confirm(`删除页面 /${p.path}？正文会一并移除，不可恢复。`)) return;
    setBusy(true);
    setMsg("");
    try {
      await api.matrixDelete(p.id);
      if (draft?.id === p.id) setDraft(null);
      await reload();
    } catch (e) {
      setMsg((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  /** 存外站认定表：整份覆盖，后端会归一化域名、去重 */
  const saveSites = async () => {
    setBusy(true);
    setMsg("");
    try {
      const r = await api.matrixSaveSites(sites);
      setSites(r.sites);
      setMsg("外站认定已保存");
    } catch (e) {
      setMsg((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  /** 存注入物的外观：主色与按钮形态整份覆盖 */
  const saveTheme = async () => {
    setBusy(true);
    setMsg("");
    try {
      const r = await api.matrixTheme(theme);
      setTheme(r.theme);
      setMsg("外观已保存");
    } catch (e) {
      setMsg((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  /** 导出矩阵包：整套（页面正文 + 连线 + 外观 + 外站认定）压成一个 zip 下载 */
  const exportPack = async () => {
    setBusy(true);
    setMsg("");
    try {
      const { blob, missing } = await api.matrixPackExport();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `matrix-${Date.now()}.zip`;
      a.click();
      URL.revokeObjectURL(url);
      // 有页没带上正文就如实说：这种包是装不回来的，别让它看着像成功
      setMsg(
        missing.length
          ? `矩阵包已导出，但有 ${missing.length} 页正文没进包（${missing
              .slice(0, 3)
              .join("、")}${missing.length > 3 ? " 等" : ""}）—— 这个包装不回这些页`
          : "矩阵包已导出",
      );
    } catch (e) {
      setMsg((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  /**
   * 装备矩阵包：整体替换线上这套。动手前先把话说清楚 ——
   * 这是「装上的就是那个包的样子」，不是往现有的里添几页。
   */
  const equipPack = async (file: File) => {
    if (
      !window.confirm(
        "装备会**整体替换**线上这套矩阵：现在的页面、连线、外观、外站认定会被包里的那一套全数盖掉。\n\n（装之前会自动留一份底，装错了可以在这一栏回滚。）\n\n继续？",
      )
    )
      return;
    setBusy(true);
    setMsg("");
    try {
      const r = await api.matrixPackEquip(file);
      await reload();
      setMsg(
        `已装备：${r.pages} 页 / ${r.links} 条连线 / ${r.sites} 条外站认定` +
          (r.droppedLinks ? `（丢了 ${r.droppedLinks} 条指向包外的连线）` : "") +
          (r.droppedSites ? `（丢了 ${r.droppedSites} 条超限的外站认定）` : "") +
          (r.snapshot ? "，装前那一版已留底" : ""),
      );
    } catch (e) {
      setMsg((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  /** 回滚：把上一次装备前的留底再装回去 */
  const rollbackPack = async () => {
    if (!window.confirm("把上一次装备前的留底装回去？（同样整体替换）")) return;
    setBusy(true);
    setMsg("");
    try {
      const r = await api.matrixPackRollback();
      await reload();
      setMsg(`已回滚到上一版：${r.pages} 页 / ${r.links} 条连线`);
    } catch (e) {
      setMsg((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  /**
   * 全景图里拖出的一条线：不填文字，落点走兜底栏 —— 后端会把按钮文字回落成
   * 目标页标题。要改文字或落点，去房间侧表改同一条。
   * 这两个 handler 必须稳定：它们会进 MatrixFlow 的 effect 依赖，每次渲染换
   * 新函数会让边反复重建。
   */
  const quickLink = useCallback(
    async (from: string, to: string) => {
      setBusy(true);
      setMsg("");
      try {
        await api.matrixLink({ from, to });
        await reload();
      } catch (e) {
        setMsg((e as Error).message);
      } finally {
        setBusy(false);
      }
    },
    [reload],
  );

  /** 全景图上断开一条通路 */
  const quickUnlink = useCallback(
    async (from: string, to: string) => {
      setBusy(true);
      setMsg("");
      try {
        await api.matrixUnlink(from, to);
        await reload();
      } catch (e) {
        setMsg((e as Error).message);
      } finally {
        setBusy(false);
      }
    },
    [reload],
  );

  /** 房间里现开一扇门：从站着的这间通到选中的那一页，落点由侧表当场挑 */
  const roomLink = useCallback(
    async (from: string, to: string, label: string, place: LinkPlace) => {
      setBusy(true);
      setMsg("");
      try {
        await api.matrixLink({ from, to, label, place });
        await reload();
      } catch (e) {
        setMsg((e as Error).message);
      } finally {
        setBusy(false);
      }
    },
    [reload],
  );

  /**
   * 改一扇门上的字。后端按 (from,to) 整条覆盖，所以落点与排序也得一起回传，
   * 漏了这两样会被静默重置成兜底栏、「order 0」。
   */
  const roomRename = useCallback(
    async (l: MatrixLink, label: string) => {
      setBusy(true);
      setMsg("");
      try {
        await api.matrixLink({
          from: l.from,
          to: l.to,
          label,
          place: l.place,
          order: l.order,
        });
        await reload();
      } catch (e) {
        setMsg((e as Error).message);
      } finally {
        setBusy(false);
      }
    },
    [reload],
  );

  /**
   * 改一扇门的落点：兜底栏 ↔ 命名锚点在侧表里当场切（拖拽落点只由预览产生）。
   * 同样得把 label 与 order 一起回传，否则会被覆盖掉。
   */
  const roomPlace = useCallback(
    async (l: MatrixLink, place: LinkPlace) => {
      setBusy(true);
      setMsg("");
      try {
        await api.matrixLink({
          from: l.from,
          to: l.to,
          label: l.label,
          place,
          order: l.order,
        });
        await reload();
      } catch (e) {
        setMsg((e as Error).message);
      } finally {
        setBusy(false);
      }
    },
    [reload],
  );

  /**
   * 预览里拖完一个按钮：把这条出边的落点改成拖到的自由坐标。
   * 后端按 (from,to) 整条覆盖，label 与 order 不回传会被静默重置，所以一并带上。
   */
  const roomMove = useCallback(
    async (from: string, to: string, x: number, y: number) => {
      const l = links.find((k) => k.from === from && k.to === to);
      if (!l) return;
      setBusy(true);
      setMsg("");
      try {
        await api.matrixLink({
          from,
          to,
          label: l.label,
          place: { kind: "point", x, y },
          order: l.order,
        });
        await reload();
      } catch (e) {
        setMsg((e as Error).message);
      } finally {
        setBusy(false);
      }
    },
    [links, reload],
  );

  /** 新开一间房，并顺手从站着的这间开一扇门过去 —— 建完就推门进去 */
  const roomCreate = useCallback(
    async (d: { path: string; title: string; access: MatrixAccess }) => {
      setBusy(true);
      setMsg("");
      try {
        const form = new FormData();
        form.append(
          "meta",
          JSON.stringify({
            path: d.path,
            title: d.title,
            access: d.access,
            types: [],
            sandbox: false,
            entry: false,
            external: "",
          }),
        );
        form.append("text", blankPage(d.title || d.path));
        const r = await api.matrixSave(form);
        const id = r.page?.id;
        const from = roomId;
        if (id && from && from !== id) await api.matrixLink({ from, to: id });
        await reload();
        if (id) walk(id);
      } catch (e) {
        setMsg((e as Error).message);
      } finally {
        setBusy(false);
      }
    },
    [reload, walk, roomId],
  );

  /** 递归铺一层：文件夹为路标（可折叠），页面才是可编辑的实体 */
  const renderBranch = (nodes: MatrixTreeNode[]): ReactNode =>
    nodes.map((n) => {
      const kids = n.children.length > 0;
      const folded = closed.has(n.path);
      const p = n.page;
      return (
        <li key={n.path}>
          <div className={`matrix-node${p ? "" : " folder"}`}>
            {kids ? (
              <button
                className={`matrix-fold${folded ? " on" : ""}`}
                onClick={() => toggleFold(n.path)}
                title={folded ? "展开" : "收起"}
                aria-expanded={!folded}
              >
                <Icon name="chevron-down" size={14} />
              </button>
            ) : (
              <span className="matrix-fold" />
            )}

            {p ? (
              <>
                <button
                  className="matrix-title"
                  onClick={() => void openEdit(p)}
                  title={`点开编辑 /${p.path}`}
                >
                  {n.name}
                </button>
                <span className="dim">{p.title || "（未命名）"}</span>
                <span className="chip">{ACCESS_LABEL[p.access]}</span>
                {p.entry && <span className="chip on">入口</span>}
                {p.sandbox && <span className="chip">沙箱</span>}
                {p.external && <span className="chip">外链</span>}
                <button
                  className="btn btn-sm btn-danger"
                  onClick={() => void remove(p)}
                  disabled={busy}
                >
                  删除
                </button>
              </>
            ) : (
              <>
                <span className="matrix-folder">{n.name}</span>
                <span className="dim">{n.count} 页</span>
                <button
                  className="btn btn-sm"
                  onClick={() => {
                    // 编辑器在列表页里：就地新建也切回列表，免得看不见
                    setTab("list");
                    setDraft({ ...emptyDraft(), path: `${n.path}/` });
                  }}
                >
                  在这里新建
                </button>
              </>
            )}
          </div>

          {kids && !folded && (
            <ul className="matrix-tree">{renderBranch(n.children)}</ul>
          )}
        </li>
      );
    });

  return (
    <>
      {/* 左导航收起来时，舞台上留一枚浮标把它叫回来。
          进了预览就多长出一条右半边 —— 左「导航」唤左栏、右「编辑」管落点手柄，
          一左一右各管各的。整枚都能拖着挪开：整屏的页面上它总压着一处。 */}
      {railClosed && (
        <div
          className={`mx-fab${fab.dragging ? " dragging" : ""}`}
          ref={fab.bind}
          style={
            fab.pos
              ? {
                  left: fab.pos.x,
                  top: fab.pos.y,
                  right: "auto",
                  bottom: "auto",
                }
              : undefined
          }
          onPointerDown={fab.onPointerDown}
          onClickCapture={fab.guardCapture}
        >
          <button
            className="mx-fab-half"
            title="展开导航"
            onClick={fab.click(() => setRail(false))}
          >
            <Icon name="layers" size={14} />
            导航
          </button>
          {tab === "preview" && (
            <>
              <span className="mx-fab-sep" aria-hidden="true" />
              <button
                className={`mx-fab-half${edit ? " on" : ""}`}
                title={
                  edit
                    ? "收起落点手柄：专心看页面"
                    : "铺开落点手柄：把按钮拖到想去的位置"
                }
                onClick={fab.click(() => setEdit((v) => !v))}
              >
                <Icon name="edit" size={14} />
                编辑
              </button>
            </>
          )}
        </div>
      )}

      <div className="mx-shell">
        {/* 左栏一收就整幅让给说明与舞台 */}
        {!railClosed && (
          <nav className="mx-rail">
            <button
              className={`mx-rail-item${tab === "list" ? " on" : ""}`}
              onClick={() => setTab("list")}
            >
              <Icon name="layers" size={15} />
              页面列表
              <span className="mx-rail-count">{pages.length}</span>
            </button>
            <button
              className={`mx-rail-item${tab === "graph" ? " on" : ""}`}
              onClick={() => setTab("graph")}
            >
              <Icon name="share" size={15} />
              矩阵图谱
            </button>
            <button
              className={`mx-rail-item${tab === "preview" ? " on" : ""}`}
              onClick={() => setTab("preview")}
            >
              <Icon name="eye" size={15} />
              页面预览
            </button>
            <button
              className={`mx-rail-item${tab === "look" ? " on" : ""}`}
              onClick={() => setTab("look")}
            >
              <Icon name="settings" size={15} />
              外观美化
            </button>
            <button
              className={`mx-rail-item${tab === "sites" ? " on" : ""}`}
              onClick={() => setTab("sites")}
            >
              <Icon name="link" size={15} />
              外站认定
              <span className="mx-rail-count">{sites.length}</span>
            </button>
            <button
              className={`mx-rail-item${tab === "pack" ? " on" : ""}`}
              onClick={() => setTab("pack")}
            >
              <Icon name="download" size={15} />
              矩阵包
            </button>
            <div className="mx-rail-foot">
              <button className="mx-rail-collapse" onClick={() => setRail(true)}>
                « 收起导航
              </button>
            </div>
          </nav>
        )}

        <div className="mx-stage">
          {loading && (
            <div className="mx-view">
              <p className="empty-sm">读取中…</p>
            </div>
          )}

          {!loading && (
            <>
              {/* 重取数据失败时给一句提示：页面还在，只是这一趟没刷新上 */}
              {err && <p className="empty-sm">{err}</p>}

              {/* 窄屏（手机）：图谱与预览都是横向铺开的面，摊不开就别硬摊。
                  只提醒不拦 —— 其余几面竖着读，手机上照常用 */}
              {narrow && (tab === "graph" || tab === "preview") && (
                <p className="mx-narrow-note">
                  手机上不建议看这一面：{tab === "graph" ? "图谱" : "预览"}
                  要横向铺开，窄屏里挤成一团。换台电脑打开工作台更省事 ——
                  页面列表、外观、外站认定、矩阵包这几面在手机上照常用。
                </p>
              )}

              {(tab === "list" || tab === "graph") && (
                <div className="mx-view-head">
                  <h4 className="mx-view-title">
                    {tab === "list" ? "页面列表" : "矩阵图谱"}
                  </h4>
                  <span className="mx-spacer" />
                  {tab === "list" && (
                    <>
                      <button
                        className="btn btn-sm"
                        onClick={() => {
                          setTab("list");
                          setDraft(emptyDraft());
                        }}
                      >
                        新建页面
                      </button>
                      <button
                        className="btn btn-sm"
                        onClick={() => void reload()}
                      >
                        刷新
                      </button>
                    </>
                  )}
                  {msg && <span className="dim">{msg}</span>}
                </div>
              )}

              {tab === "list" && (
                <div className="mx-view mx-list">
                  <div className="mx-list-tree">
                    {tree.length === 0 ? (
                      <p className="empty-sm">
                        还没有页面。点「新建页面」挂上第一页。
                      </p>
                    ) : (
                      <ul className="matrix-tree">{renderBranch(tree)}</ul>
                    )}
                  </div>

                  <div className="mx-list-edit">
                    {draft ? (
                      <div className="settings-card matrix-editor">
                        <h4 className="sect">
                          {draft.id ? "编辑页面" : "新建页面"}
                        </h4>

                        <label className="field-label">
                          层级路径（最多 3 段，如 thisme/foryou）
                        </label>
                        <input
                          className="field"
                          value={draft.path}
                          placeholder="thisme/foryou"
                          onChange={(e) =>
                            setDraft({
                              ...draft,
                              path: e.target.value.trim().toLowerCase(),
                            })
                          }
                        />

                        <label className="field-label">标题</label>
                        <input
                          className="field"
                          value={draft.title}
                          placeholder="给这一页起个名字（导航里显示）"
                          onChange={(e) =>
                            setDraft({ ...draft, title: e.target.value })
                          }
                        />

                        <label className="field-label">身份档</label>
                        <select
                          className="field"
                          value={draft.access}
                          onChange={(e) =>
                            setDraft({
                              ...draft,
                              access: e.target.value as MatrixAccess,
                            })
                          }
                        >
                          <option value="public">公开 —— 任何人可见</option>
                          <option value="visitor">
                            持票来客 —— 登录后可见
                          </option>
                          <option value="admin">管理员 —— 仅管理员</option>
                          <option value="types">
                            指定档位 —— 下列来客档可见
                          </option>
                        </select>

                        {draft.access === "types" && (
                          <div className="matrix-chips">
                            {guestTypes.length === 0 && (
                              <span className="dim">还没有来客档位</span>
                            )}
                            {guestTypes.map((t) => {
                              const on = draft.types.includes(t.id);
                              return (
                                <button
                                  key={t.id}
                                  className={`chip${on ? " on" : ""}`}
                                  onClick={() =>
                                    setDraft({
                                      ...draft,
                                      types: on
                                        ? draft.types.filter((x) => x !== t.id)
                                        : [...draft.types, t.id],
                                    })
                                  }
                                >
                                  {t.name}
                                  {t.active === false ? "（停用）" : ""}
                                </button>
                              );
                            })}
                          </div>
                        )}

                        <div className="matrix-toggles">
                          <label>
                            <input
                              type="checkbox"
                              checked={draft.sandbox}
                              disabled={draft.entry}
                              onChange={(e) =>
                                setDraft({ ...draft, sandbox: e.target.checked })
                              }
                            />
                            沙箱（禁止页面读写宿主 cookie / 存储）
                          </label>
                          <label>
                            <input
                              type="checkbox"
                              checked={draft.entry}
                              onChange={(e) =>
                                setDraft({
                                  ...draft,
                                  entry: e.target.checked,
                                  // 入口页必须公开、不许沙箱：它是所有人的门面
                                  access: e.target.checked
                                    ? "public"
                                    : draft.access,
                                  sandbox: e.target.checked
                                    ? false
                                    : draft.sandbox,
                                })
                              }
                            />
                            设为入口页（公开访客访问根路径时来到这页）
                          </label>
                        </div>

                        <label className="field-label">
                          外站链接（填了就只作导航外链，不出本地正文）
                        </label>
                        <input
                          className="field"
                          value={draft.external}
                          placeholder="https://example.com"
                          onChange={(e) =>
                            setDraft({ ...draft, external: e.target.value })
                          }
                        />

                        {!draft.external && (
                          <>
                            <label className="field-label">正文来源</label>
                            <select
                              className="field"
                              value={draft.source}
                              onChange={(e) =>
                                setDraft({
                                  ...draft,
                                  source: e.target.value as Source,
                                })
                              }
                            >
                              {draft.id && (
                                <option value="keep">沿用原正文</option>
                              )}
                              <option value="paste">粘贴 HTML 源码</option>
                              <option value="upload">上传 HTML 文件</option>
                              <option value="drive">选云盘里的文件</option>
                            </select>

                            {draft.source === "paste" && (
                              <HtmlEditor
                                value={draft.text}
                                disabled={busy}
                                rows={14}
                                placeholder="<!DOCTYPE html> …"
                                onChange={(v) => setDraft({ ...draft, text: v })}
                              />
                            )}
                            {draft.source === "upload" && (
                              <input
                                className="field"
                                type="file"
                                accept=".html,.htm,text/html"
                                onChange={(e) =>
                                  setDraft({
                                    ...draft,
                                    file: e.target.files?.[0] ?? null,
                                  })
                                }
                              />
                            )}
                            {draft.source === "drive" && (
                              <>
                                <select
                                  className="field"
                                  value={draft.driveKey}
                                  onChange={(e) =>
                                    setDraft({
                                      ...draft,
                                      driveKey: e.target.value,
                                    })
                                  }
                                >
                                  <option value="">选择云盘文件…</option>
                                  {files.slice(0, 300).map((f) => (
                                    <option key={f.key} value={f.key}>
                                      {f.key}
                                    </option>
                                  ))}
                                </select>
                                <p className="dim mx-hint">
                                  引用的是那只文件的当下内容：云盘里改了，这页跟着变。所以在云盘那边
                                  这只文件不能删、也不能搬走（会被拦住）—— 要断开引用就换一档来源再保存。
                                </p>
                              </>
                            )}

                            <label className="field-label">
                              本页 CSS（只作用这一页，排在矩阵默认样式之后；填了就不跟全局换肤走）
                            </label>
                            <textarea
                              className="field mx-css"
                              rows={6}
                              spellCheck={false}
                              placeholder={".hero{font-size:32px}\n/* 不能用 @import、外站 url() 与 </style> */"}
                              value={draft.css}
                              onChange={(e) =>
                                setDraft({ ...draft, css: e.target.value })
                              }
                            />
                          </>
                        )}

                        {/* 出口（连线）不在这儿配：按钮不属于页面内容，是矩阵渲染时按落点
                            拼进去的，统一收口在房间侧表里改 —— 一个地方管，不两头串。 */}

                        {/* 正文要换了：先摆改动，点了头才写 */}
                        {pending && (
                          <>
                            <div className="row-actions">
                              <strong>正文有改动</strong>
                              <span className="dim">
                                确认后原正文被替换，不可回退
                              </span>
                              <span className="mp-spacer" />
                              <button
                                className="btn btn-primary btn-sm"
                                disabled={busy}
                                onClick={() => void commit()}
                              >
                                确认写入
                              </button>
                              <button
                                className="btn btn-ghost btn-sm"
                                disabled={busy}
                                onClick={() => setPending(null)}
                              >
                                再看看
                              </button>
                            </div>
                            {pending.lines ? (
                              <DiffView lines={pending.lines} />
                            ) : (
                              <p className="dim">
                                改动太大，没逐行比 —— 确认写入会把整篇正文换掉。
                              </p>
                            )}
                          </>
                        )}

                        <div className="row-actions">
                          <button
                            className="btn btn-primary btn-sm"
                            onClick={() => void save()}
                            disabled={busy}
                          >
                            {busy ? "保存中…" : "保存"}
                          </button>
                          <button
                            className="btn btn-ghost btn-sm"
                            onClick={() => {
                              setDraft(null);
                              setPending(null);
                            }}
                            disabled={busy}
                          >
                            取消
                          </button>
                        </div>
                      </div>
                    ) : (
                      <p className="dim mx-empty">从左边挑一页，或新建一页</p>
                    )}
                  </div>
                </div>
              )}

              {tab === "graph" && (
                <div className="mx-view">
                  {pages.length === 0 ? (
                    <p className="empty-sm">
                      还没有页面 —— 先去「页面列表」挂上第一页。
                    </p>
                  ) : (
                    <>
                      <div className="row-actions">
                        <button
                          className={`chip${view === "room" ? " on" : ""}`}
                          onClick={() => setView("room")}
                        >
                          房间
                        </button>
                        <button
                          className={`chip${view === "map" ? " on" : ""}`}
                          onClick={() => setView("map")}
                        >
                          全景
                        </button>
                        <span className="dim">
                          {pages.length} 节点 · {links.length} 通路
                        </span>
                      </div>

                      {view === "room" ? (
                        roomId ? (
                          <MatrixRoom
                            pages={pages}
                            links={links}
                            currentId={roomId}
                            trail={trail}
                            busy={busy}
                            onWalk={walk}
                            onOpen={(p) => void openEdit(p)}
                            onLink={(from, to, label, place) =>
                              void roomLink(from, to, label, place)
                            }
                            onRename={(l, label) => void roomRename(l, label)}
                            onPlace={(l, place) => void roomPlace(l, place)}
                            onUnlink={(from, to) => void quickUnlink(from, to)}
                            onCreate={(d) => void roomCreate(d)}
                          />
                        ) : (
                          <p className="empty-sm">正在找入口页…</p>
                        )
                      ) : (
                        <MatrixFlow
                          pages={pages}
                          links={links}
                          onOpen={(p) => void openEdit(p)}
                          onLink={(from, to) => void quickLink(from, to)}
                          onUnlink={(from, to) => void quickUnlink(from, to)}
                        />
                      )}

                      <p className="dim mx-hint">
                        {view !== "room"
                          ? "从节点右侧的圆点拖到另一节点即可连线，连线上的 × 断开一条，点节点打开编辑器。节点位置只摆在图里，不进库。"
                          : "点一扇门就走过去，走过的路在上面的脚印里，点前面一截可以回头。右边那栏是调整器：改门上的字、挑落点（兜底栏 / 命名锚点）、断一扇门、开一扇新门、顺手新开一间房。到「页面预览」可以进屋看整页、拖按钮定落点。"}
                      </p>
                    </>
                  )}
                </div>
              )}

              {tab === "preview" && (
                /* 预览自己 fixed 铺满整屏（下层），这层壳只管把内边距收干净 */
                <div className="mx-view bare">
                  <MatrixPreview
                    pages={pages}
                    links={links}
                    currentId={roomId}
                    busy={busy}
                    version={linksVersion}
                    editing={edit}
                    onWalk={walk}
                    onOpen={(p) => void openEdit(p)}
                    onMove={(from, to, x, y) => void roomMove(from, to, x, y)}
                  />
                </div>
              )}

              {tab === "look" && (
                <div className="mx-view narrow">
                  {/* 矩阵外观：注入到每一页的那层壳（通路按钮 + 悬浮菜单）长什么样。
                      一处调、全站变；页面自己写的 CSS 是另一回事，在这里管不着。 */}
                  <div className="settings-card">
                    <h4 className="sect">矩阵外观</h4>
                    <p className="dim">
                      注入到每一页的按钮与悬浮菜单都走这一套壳 —— 改一次，全站一起变。
                      页面自己在正文里写的样式另算，不跟着走。
                    </p>
                    <div className="row-actions">
                      <button
                        className={`chip${navOn ? " on" : ""}`}
                        disabled={busy}
                        title="在每页左上角挂一个半透明浮窗，列出当前身份能去的页面"
                        onClick={() => {
                          const next = !navOn;
                          setNavOn(next);
                          setBusy(true);
                          setMsg("");
                          api
                            .matrixNav(next)
                            .then(() =>
                              setMsg(next ? "悬浮菜单已开" : "悬浮菜单已关"),
                            )
                            .catch((e: unknown) => {
                              setNavOn(!next); // 没存上就把开关拨回去，别骗人
                              setMsg((e as Error).message);
                            })
                            .finally(() => setBusy(false));
                        }}
                      >
                        悬浮菜单{navOn ? "：开" : "：关"}
                      </button>
                    </div>

                    <label className="field-label">主色</label>
                    <div className="row-actions">
                      <input
                        type="color"
                        className="mx-color"
                        value={theme.accent}
                        disabled={busy}
                        onChange={(e) =>
                          setTheme({ ...theme, accent: e.target.value })
                        }
                      />
                      <span className="dim">{theme.accent}</span>
                    </div>

                    <label className="field-label">按钮形态</label>
                    <select
                      className="field"
                      value={theme.button}
                      disabled={busy}
                      onChange={(e) =>
                        setTheme({
                          ...theme,
                          button: e.target.value as MatrixTheme["button"],
                        })
                      }
                    >
                      <option value="text">文字链接</option>
                      <option value="outline">描边按钮</option>
                      <option value="solid">实底按钮</option>
                    </select>

                    <div className="row-actions">
                      <button
                        className="btn btn-sm"
                        disabled={busy}
                        onClick={() => void saveTheme()}
                      >
                        保存外观
                      </button>
                      {msg && <span className="dim">{msg}</span>}
                    </div>
                  </div>
                </div>
              )}

              {tab === "sites" && (
                <div className="mx-view narrow">
                  {/* 外站认定：从内站往站外走的唯一出口是门卫页，它拿目标域名来这张表比对。
                      表外的地址一律拦下 —— 空表也就是「谁都不放行」，是安全的那一侧。 */}
                  <div className="settings-card">
                    <h4 className="sect">外站认定</h4>
                    <p className="dim">
                      只有列在这张表里的域名才准从内站过去。去外站时先停门卫页提醒一句；
                      勾了「免提示」的域名不再停。表外的地址（含伪造的跳转目标）一律拦下。
                    </p>
                    {sites.length === 0 && (
                      <p className="dim">
                        还没有认定的外站 —— 现在所有外站都会被门卫拦下。
                      </p>
                    )}
                    {sites.map((s, i) => (
                      /* key 只认序号：这张表是就地改的，没有稳定 id。
                         早先 key 里掺了 host，改域名时每敲一个字 key 就变一次 ——
                         整行重挂，正在打字的那格当场失焦，后面的字全丢在外面 */
                      <div className="matrix-site" key={i}>
                        <input
                          className="field"
                          value={s.host}
                          placeholder="example.com"
                          disabled={busy}
                          onChange={(e) => {
                            const next = [...sites];
                            next[i] = { ...s, host: e.target.value };
                            setSites(next);
                          }}
                        />
                        <input
                          className="field"
                          value={s.note ?? ""}
                          placeholder="备注（为什么放行）"
                          disabled={busy}
                          onChange={(e) => {
                            const next = [...sites];
                            next[i] = { ...s, note: e.target.value };
                            setSites(next);
                          }}
                        />
                        <label className="matrix-site-skip">
                          <input
                            type="checkbox"
                            checked={!!s.skip}
                            disabled={busy}
                            onChange={(e) => {
                              const next = [...sites];
                              next[i] = { ...s, skip: e.target.checked };
                              setSites(next);
                            }}
                          />
                          免提示
                        </label>
                        <button
                          className="btn btn-ghost btn-sm"
                          disabled={busy}
                          onClick={() =>
                            setSites(sites.filter((_, j) => j !== i))
                          }
                        >
                          删除
                        </button>
                      </div>
                    ))}
                    <div className="row-actions">
                      <button
                        className="btn btn-ghost btn-sm"
                        disabled={busy}
                        onClick={() =>
                          setSites([
                            ...sites,
                            { host: "", note: "", skip: false },
                          ])
                        }
                      >
                        加一个域名
                      </button>
                      <button
                        className="btn btn-sm"
                        disabled={busy}
                        onClick={() => void saveSites()}
                      >
                        保存认定
                      </button>
                      {msg && <span className="dim">{msg}</span>}
                    </div>
                  </div>
                </div>
              )}

              {tab === "pack" && (
                <div className="mx-view narrow">
                  {/* 矩阵包：整套矩阵与一个 zip 互转。装备是**整体替换** ——
                      本地照包准则做熟、传一次就上线，云端这套编辑面只用来零星改动 */}
                  <div className="settings-card">
                    <h4 className="sect">矩阵包</h4>
                    <p className="dim">
                      一个 zip 装一次就成形。包里有页面正文、连线、全局外观、悬浮菜单
                      与外站认定 —— 在本地照包准则做熟，传上来就是成品。
                    </p>
                    <p className="dim">
                      装备是<strong>整体替换</strong>：现在这套会被包里的那一套全数盖掉。
                      动手前会自动留一份底，装错了可以回滚。
                    </p>
                    <div className="row-actions">
                      <button
                        className="btn btn-sm"
                        disabled={busy}
                        onClick={() => void exportPack()}
                      >
                        <Icon name="download" size={14} />
                        导出当前矩阵
                      </button>
                      <button
                        className="btn btn-ghost btn-sm"
                        disabled={busy}
                        onClick={() => packInput.current?.click()}
                      >
                        <Icon name="upload" size={14} />
                        装备一个包
                      </button>
                      <button
                        className="btn btn-ghost btn-sm"
                        disabled={busy}
                        onClick={() => void rollbackPack()}
                      >
                        <Icon name="undo" size={14} />
                        回滚到上一版
                      </button>
                      {msg && <span className="dim">{msg}</span>}
                    </div>
                    <input
                      ref={packInput}
                      type="file"
                      accept=".zip,application/zip"
                      style={{ display: "none" }}
                      onChange={(e) => {
                        const f = e.target.files?.[0];
                        // 清掉 value：不然连着选同一个文件不会再触发 change
                        e.target.value = "";
                        if (f) void equipPack(f);
                      }}
                    />
                  </div>

                  <div className="settings-card">
                    <h4 className="sect">包长什么样</h4>
                    <pre className="mx-pack-tree">{`matrix.json       清单：format / version / config（页面、连线、外观、外站认定）
pages/<id>.html   页面正文，一页一个；外站页与「引用云盘文件」的页不带正文`}</pre>
                    <p className="dim">
                      页面 id 只认小写字母与数字（它要拼进云盘的 key）。路径、身份档位、
                      入口页、本页 CSS 都会照「保存一页」那套规矩重新过尺 ——
                      不合规的包当场打回，一个字节都不落。
                    </p>
                    <p className="dim">
                      上限：单文件 50MB、总量 200MB、单页正文 2MB、条目 1000 个。
                      包里的连线指向包外页面时会丢掉（悬空的线只会把图撕裂），丢了几条会报出来。
                    </p>
                    <p className="dim">
                      包只装成品矩阵，不含工作台本身 —— 工作台是「读配置的程序」，随主包走。
                      另外它保证的是「同一套云盘里可复现」：引用云盘文件的页在换了存储的环境里读不到正文。
                    </p>
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </>
  );
}
