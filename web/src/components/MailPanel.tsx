// 邮件（SMTP 发信账号 + 两个开关 + 默认收件地址表）：一条配置 = 一行只读摘要 + 一个详情弹页。
//
// 为什么单独一个文件：Panels2.tsx 已经 3800 多行（它自己就是从 Panels.tsx 拆出来的），
// 而且这里要新增的 import 得改文件头 —— 那份文件的规矩是只许在末尾追加。
// 规则全部外提在 ../lib/mailForm.ts，这里只接线：读视图、拍草稿、按下保存才提交。
// 界面上没有口令输入框，也不回显口令 —— 凭据只填 secret 的变量名，和模型目录同一口径。
//
// 发件流水与收件箱那两块面不在这儿，见 MailBoxPanels.tsx。

import { useCallback, useEffect, useState } from "react";
import { api } from "../lib/api";
import {
  MAX_DAILY_CAP,
  MAX_TO_ADDRESSES,
  addressCellProblem,
  addressTableRemove,
  addressTableSet,
  blankMailDraft,
  draftAddressTable,
  draftKeyMissing,
  inboxEnabledHint,
  inboxEnabledSummary,
  isMailAddress,
  keyMissingHint,
  keySecretHint,
  lastSendNote,
  mailDraftOf,
  mailMissingFields,
  mailPayloadOf,
  mailSummary,
  mailWithSecure,
  sayMailHint,
  sayMailSummary,
  securePortHint,
  testSentNote,
  type MailDraft,
} from "../lib/mailForm";
import type { MailConfigPatchFull, MailConfigViewFull } from "../lib/types";
import {
  EntityAddButton,
  EntityNote,
  EntityRow,
  FormDialog,
  FormRow,
  FormSection,
  useDraft,
} from "./FormDialog";
import { fmtWhen } from "./PanelsShared";
import "./MailPanel.css";

/** 加密方式下拉的取值：契约里 secure 是布尔，界面上得说成两扇门 */
const TLS_IMPLICIT = "implicit";
const TLS_STARTTLS = "starttls";

/** 地址表编辑器：idx 是改第几行，null 是加一行 */
interface AddrEditing {
  idx: number | null;
}

export function MailPanel() {
  const [view, setView] = useState<MailConfigViewFull | null>(null);
  // 变量名候选与模型目录共用一本册子（这台机器配过的 secret 名都在那儿）
  const [keySecrets, setKeySecrets] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState("");
  // hook 一律留在函数体最上面：放到下面那两个早退之后，React 会报
  // "Rendered more hooks than during the previous render"，面板就永久停在「读取中…」
  const form = useDraft<MailDraft>(blankMailDraft());
  const [dialog, setDialog] = useState(false);
  const [dialogErr, setDialogErr] = useState("");
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testNote, setTestNote] = useState("");
  const [toggling, setToggling] = useState(false);
  // 地址表那一格的编辑窗（和配置弹页不叠着开，见 openAddr 上那段说明）
  const addrForm = useDraft("");
  const [addrDialog, setAddrDialog] = useState<AddrEditing | null>(null);
  const [addrErr, setAddrErr] = useState("");

  const load = useCallback(async () => {
    try {
      const [cfg, catalog] = await Promise.all([
        api.mailConfig(),
        // 候选清单读不到不该连累邮件面：空数组 = 下拉没料，照常手填
        api
          .modelCatalog()
          .then((c) => c.keySecrets)
          .catch(() => [] as string[]),
      ]);
      setView(cfg);
      setKeySecrets(catalog);
      setErr("");
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const patch = (p: Partial<MailDraft>) =>
    form.setDraft((prev) => ({ ...prev, ...p }));

  const open = () => {
    if (!view) return;
    // 弹页改的是「打开这一刻拍下的快照」，行上那份是服务器现值
    form.reset(mailDraftOf(view));
    setDialogErr("");
    setTestNote("");
    setDialog(true);
  };

  const close = () => {
    setDialog(false);
    setDialogErr("");
    setTestNote("");
  };

  /** 草稿里那张地址表（行上摆的就是它拆出来的那几行） */
  const toAddrs = draftAddressTable(form.draft);

  /**
   * 打开地址表里那一格的编辑窗。
   *
   * 先把配置弹页收起来再开这一个：FormDialog 是共享样板（这轮不改它），
   * 两层叠着开会各装一份 Esc 监听 —— 按一下把两个窗一起关掉，草稿还没落。
   * 草稿住在面板这一层，收窗不动它，所以回来时那一表地址还是刚才改的样子。
   */
  const openAddr = (idx: number | null) => {
    setDialog(false);
    addrForm.reset(idx === null ? "" : (toAddrs[idx] ?? ""));
    setAddrErr("");
    setAddrDialog({ idx });
  };

  const closeAddr = () => {
    setAddrDialog(null);
    setAddrErr("");
    setDialog(true);
  };

  /** 地址编辑窗里的「保存」：只写回草稿那一格，整份配置仍等外面那个保存按钮 */
  const saveAddr = () => {
    if (!addrDialog) return;
    const problem = addressCellProblem(addrForm.draft, toAddrs, addrDialog.idx);
    if (problem) {
      setAddrErr(problem);
      return;
    }
    form.setDraft((prev) => ({
      ...prev,
      to: addressTableSet(prev.to, addrDialog.idx, addrForm.draft),
    }));
    setAddrDialog(null);
    setDialog(true);
  };

  const removeAddr = (idx: number) =>
    form.setDraft((prev) => ({
      ...prev,
      to: addressTableRemove(prev.to, idx),
    }));

  /**
   * 保存：成了就重读一遍再关窗 —— 行显示的是落库后的真值，不做乐观更新
   */
  const save = async () => {
    if (saving) return;
    const missing = mailMissingFields(form.draft);
    if (missing.length) {
      setDialogErr(missing.map((m) => m.message).join("；"));
      return;
    }
    setSaving(true);
    setDialogErr("");
    try {
      await api.mailConfigSave(mailPayloadOf(form.draft));
      await load();
      setDialog(false);
    } catch (e) {
      // 后端校验不过（主机名不通、变量名没配之类）原样摆在弹页里，不关窗
      setDialogErr((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  /**
   * 测试发送：lib/http.ts 把 200 里的 {ok:false,error} 也抛成错，
   * 所以走到 catch 就是真没发出去 —— 那句原话留在弹页里，不关窗、不当成功。
   * 收件人是一张表，而这一封只寄给头一个（那格接口仍收单个地址）。
   */
  const sendTest = async () => {
    if (testing || saving) return;
    setTesting(true);
    setDialogErr("");
    setTestNote("");
    const first = toAddrs[0] ?? "";
    try {
      await api.mailTest(first || undefined);
      setTestNote(testSentNote(first, toAddrs.length - 1));
    } catch (e) {
      setDialogErr((e as Error).message);
    } finally {
      setTesting(false);
    }
  };

  /**
   * 行上那几个开关：后端按整份配置覆盖，所以只翻要动的那一格，
   * 其余照行上现值原样带上 —— 从草稿里拿会把人没保存的改动一起送出去。
   */
  const setFlag = async (which: "enabled" | "sayMail" | "inboxEnabled", value: boolean) => {
    if (!view || toggling) return;
    setToggling(true);
    setErr("");
    try {
      const base = mailPayloadOf(mailDraftOf(view));
      const payload: MailConfigPatchFull =
        which === "enabled"
          ? { ...base, enabled: value }
          : which === "sayMail"
            ? { ...base, sayMail: value }
            : { ...base, inboxEnabled: value };
      await api.mailConfigSave(payload);
      await load();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setToggling(false);
    }
  };

  if (loading) return <p className="empty-sm">读取中…</p>;
  if (!view)
    return <p className="err">{err || "这台机器上还没有邮件配置可读。"}</p>;

  // 钥匙配没配：没改过那一格就信后端那份只读事实，改过了拿候选清单比一比
  const keyGone = draftKeyMissing(form.draft.keySecret, view);
  const savedKeyGone = !!view.keySecret.trim() && !view.keyAvailable;
  const portHint = securePortHint(form.draft.port, form.draft.secure);
  const last = view.lastSend;
  const lastLine = lastSendNote(last, last ? fmtWhen(last.at) : "");

  return (
    <div className="panel-body">
      <p className="meta">
        ericher 往外寄东西（到点的提醒这类）走的就是这一个发信账号；没点名寄给谁时，
        按发信账号里那张默认收件地址表走。口令不进浏览器：这里只填 secret 的变量名，
        口令本体用 wrangler 配进这台机器。按下保存才生效。
      </p>

      <div className="entity-list">
        <EntityRow
          title="发信账号"
          summary={<span className="mail-summary-wrap">{mailSummary(view)}</span>}
          editing={dialog}
          onEdit={open}
          right={
            <label
              className="toggle-switch"
              title={view.enabled ? "关掉就不再往外寄信" : "打开：按这一行说的门与地址往外寄信"}
            >
              <input
                type="checkbox"
                checked={view.enabled}
                disabled={toggling || saving}
                onChange={(e) => void setFlag("enabled", e.target.checked)}
                aria-label="启用邮件发信"
              />
              <span className="toggle-slider" />
            </label>
          }
        />
        {/* 两个开关各占一行：默认都关着，关着是什么行为写在行上 ——
            等人点进弹页或等到某封信没寄到才发现，就晚了 */}
        <EntityRow
          title="提醒寄副本"
          summary={sayMailSummary(!!view.sayMail)}
          right={
            <label className="toggle-switch" title={sayMailHint(!!view.sayMail)}>
              <input
                type="checkbox"
                checked={!!view.sayMail}
                disabled={toggling || saving}
                onChange={(e) => void setFlag("sayMail", e.target.checked)}
                aria-label="提醒与盯梢另寄邮件副本"
              />
              <span className="toggle-slider" />
            </label>
          }
        />
        <EntityRow
          title="收信落库"
          summary={inboxEnabledSummary(!!view.inboxEnabled)}
          right={
            <label className="toggle-switch" title={inboxEnabledHint(!!view.inboxEnabled)}>
              <input
                type="checkbox"
                checked={!!view.inboxEnabled}
                disabled={toggling || saving}
                onChange={(e) => void setFlag("inboxEnabled", e.target.checked)}
                aria-label="收信落库"
              />
              <span className="toggle-slider" />
            </label>
          }
        />
      </div>

      {/* 只有一行配置，变量没配这件事直接摊在行下面 —— 别等人点进弹页才发现发不出去 */}
      {savedKeyGone && <p className="err">{keyMissingHint(view.keySecret)}</p>}
      {toggling && <p className="empty-sm">保存中…</p>}
      {err && <p className="err">{err}</p>}

      {dialog && (
        <FormDialog
          wide
          title="发信账号"
          subtitle="这一份配置全局只有一条；按下保存才提交，改的东西在保存前都只是草稿。"
          busy={saving || testing}
          error={dialogErr}
          dirty={form.dirty(form.draft)}
          onClose={close}
          onSave={() => void save()}
        >
          <FormSection title="连接">
            <FormRow
              label="主机名"
              hint="服务商给的那台发信服务器，不带协议前缀；只用字母、数字、点、连字符"
            >
              <input
                className="field"
                placeholder="smtp.example.test"
                value={form.draft.hostname}
                onChange={(e) => patch({ hostname: e.target.value })}
              />
            </FormRow>
            <FormRow
              label="端口"
              hint={
                portHint ||
                "常见：465 / 997 走隐式 TLS，587 明文起步再 STARTTLS"
              }
            >
              <input
                className="field"
                inputMode="numeric"
                placeholder="465"
                value={form.draft.port}
                onChange={(e) => patch({ port: e.target.value })}
              />
            </FormRow>
            <FormRow
              label="加密方式"
              hint="换这一档时，还停在另一扇标准门上的端口会跟着换对"
            >
              <select
                className="field"
                value={form.draft.secure ? TLS_IMPLICIT : TLS_STARTTLS}
                aria-label="加密方式"
                onChange={(e) =>
                  form.setDraft(
                    mailWithSecure(form.draft, e.target.value === TLS_IMPLICIT),
                  )
                }
              >
                <option value={TLS_IMPLICIT}>隐式 TLS（465 / 997）</option>
                <option value={TLS_STARTTLS}>
                  STARTTLS 起步（587，升级失败就断连，绝不在明文上认证）
                </option>
              </select>
            </FormRow>
          </FormSection>

          <FormSection title="凭据">
            <FormRow label="登录用户名" hint="通常就是发件地址本身，有的服务商另给一个">
              <input
                className="field"
                autoComplete="off"
                placeholder="发信用的登录名"
                value={form.draft.username}
                onChange={(e) => patch({ username: e.target.value })}
              />
            </FormRow>
            <FormRow label="密钥变量名" hint={keySecretHint(form.draft.keySecret)} wide>
              <input
                className="field"
                list="mail-key-secrets"
                autoComplete="off"
                placeholder="MAIL_KEY"
                value={form.draft.keySecret}
                onChange={(e) => patch({ keySecret: e.target.value })}
              />
            </FormRow>
            {keyGone && (
              <p className="err">{keyMissingHint(form.draft.keySecret)}</p>
            )}
            <EntityNote>
              这一栏填的是 secret 的变量名，不是口令：先在终端跑 npx wrangler
              secret put MAIL_KEY 把口令配进这台机器，再回来填变量名
              {keySecrets.length ? "，配过的名字会出现在下拉里" : ""}。
            </EntityNote>
          </FormSection>

          <FormSection title="地址">
            <FormRow label="发件地址" hint="信落在对方收件箱时显示的那个地址">
              <input
                className="field"
                placeholder="ericher@example.test"
                value={form.draft.from}
                onChange={(e) => patch({ from: e.target.value })}
              />
            </FormRow>
          </FormSection>

          {/* 默认收件地址从「一格输入条」变成「一张表」：行只读、悬停才露铅笔与垃圾桶，
              点开来是一个只有一格的编辑窗，按下保存才写回草稿这一格。 */}
          <FormSection title={`默认收件地址表（${toAddrs.length}）`}>
            <EntityNote>
              没点名寄给谁时就去这些地址，一行一个，最多 {MAX_TO_ADDRESSES} 个；
              提交时拼成一行一个的文本存进配置。测试发送只寄给头一个。
            </EntityNote>
            {!!toAddrs.length && (
              <div className="entity-list">
                {toAddrs.map((a, i) => (
                  <EntityRow
                    key={`${a}-${i}`}
                    title={a}
                    summary={
                      !isMailAddress(a)
                        ? "这一条不像邮箱地址：改一改再保存"
                        : i === 0
                          ? "头一个：测试发送寄给它"
                          : `第 ${i + 1} 个`
                    }
                    editing={addrDialog?.idx === i}
                    onEdit={() => openAddr(i)}
                    onDelete={() => removeAddr(i)}
                    deleteConfirm={`把 ${a} 从默认收件地址表里删掉？`}
                  />
                ))}
              </div>
            )}
            {!toAddrs.length && (
              <EntityNote>表是空的：没点名寄给谁时，信不知道该落到谁那儿。</EntityNote>
            )}
            <EntityAddButton
              label="加一个收件地址"
              onClick={() => openAddr(null)}
              disabled={toAddrs.length >= MAX_TO_ADDRESSES}
            />
            {toAddrs.length >= MAX_TO_ADDRESSES && (
              <EntityNote>
                到上限了（{MAX_TO_ADDRESSES} 个）：想再加先把哪一行不再用了删掉。
              </EntityNote>
            )}
          </FormSection>

          <FormSection title="限额">
            <FormRow
              label="每日上限"
              hint={`一天最多往外寄几封，超了就当天停手；0 到 ${MAX_DAILY_CAP}`}
            >
              <input
                className="field"
                inputMode="numeric"
                placeholder="20"
                value={form.draft.dailyCap}
                onChange={(e) => patch({ dailyCap: e.target.value })}
              />
            </FormRow>
          </FormSection>

          <FormSection title="试发">
            {lastLine ? (
              <EntityNote>{lastLine}</EntityNote>
            ) : (
              <EntityNote>
                这台机器上还没寄出过信 —— 试一发才知道通不通。
              </EntityNote>
            )}
            <button
              className="btn btn-ghost btn-sm"
              type="button"
              onClick={() => void sendTest()}
              disabled={saving || testing}
              title="用这台机器上已保存的那份配置寄一封"
            >
              {testing ? "发送中…" : "发一封测试邮件"}
            </button>
            {testNote && <p className="meta">{testNote}</p>}
            <EntityNote>
              测的是已保存的配置：连接、钥匙、限额这些改过但还没按保存的都不生效。
              收件人用上面那张表头一行填的值（那一格还没保存也算），表空着就按已保存那张表的头一个寄。
            </EntityNote>
          </FormSection>
        </FormDialog>
      )}

      {/* 地址表里那一格的编辑窗：整窗就一个地址，按下保存才写回草稿 */}
      {addrDialog && (
        <FormDialog
          title={addrDialog.idx === null ? "加一个收件地址" : "改这一行收件地址"}
          subtitle="只写进上面那张表（草稿里），要等配置弹页按下保存才落到这台机器上。"
          error={addrErr}
          dirty={addrForm.dirty(addrForm.draft)}
          onClose={closeAddr}
          onSave={saveAddr}
        >
          <FormSection title="地址">
            <FormRow
              label="收件地址"
              hint="一个 @、域名里带点；尖括号、逗号、空格都不收 —— 那种串进协议行能夹命令"
              wide
            >
              <input
                className="field"
                autoComplete="off"
                placeholder="owner@example.test"
                value={addrForm.draft}
                onChange={(e) => addrForm.setDraft(e.target.value)}
              />
            </FormRow>
            <EntityNote>
              重复的不用怕填两遍：同一个地址（不分大小写）只算一行，
              这张表最多 {MAX_TO_ADDRESSES} 个。
            </EntityNote>
          </FormSection>
        </FormDialog>
      )}

      {/* datalist 挂在弹页外面：打开时它得在 DOM 里，候选名才出得来 */}
      <datalist id="mail-key-secrets">
        {keySecrets.map((k) => (
          <option key={k} value={k} />
        ))}
      </datalist>
    </div>
  );
}
