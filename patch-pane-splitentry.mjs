#!/usr/bin/env node
// ============================================================
// ZCode 桌面端分屏创建入口补丁 v5(渲染层 styles-*.js)
// ============================================================
// v1 点击无反应;v2 点击即崩 fbn "reading 'workspaceIdentity'";v3 静默无效;
// v4 修成(装机实证可分屏)。
// v5 增补「空窗格可被侧栏填充」:
//   官方侧栏开会话路由 vbn 的门槛 _bn(e) 要求「被切走的会话已在某窗格」
//   (官方流造窗格必带会话,空窗格 sessionId=null 永远进不了路由,主人实测
//   分屏后无法选对话)。放宽为:焦点窗格有 panes 条目且无会话时也放行——
//   点侧栏对话即经官方 replacePaneBinding 流填进该空窗格,填完后官方
//   draft-split「窗格跟随侧栏」语义自然接管。组模式路由保持官方原样。
// v4 核心(实读官方语义):主窗格 paneId=字面量 workspace-main 永不在 panes
//   表,其 workspace 由标签 store(R1e 工厂,B1e Provider 活实例)决定
//   (官方 c3 即此推导);onClick 对非主窗格用 panes[pid].workspaceScope
//   原样,主窗格回退 __zTabStoreLive 构造 {workspacePath,workspaceIdentity?}
//   (官方 ebn 持久化同形状);pid 自检在主布局 root 树;组模式 no-op。
// 其余:store/split 函数/组 store 句柄动态捕获挂 globalThis,<4 守卫与均分
// 走官方逻辑与 __zpaneBalance;onClick 注入前独立过 node --check。
// 幂等:含 __zPaneStore 即跳过。
// 用法:node patch-pane-splitentry.mjs <styles-*.js 路径>
import { readFileSync, writeFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";

const p = process.argv[2];
if (!p) { console.error("usage: node patch-pane-splitentry.mjs <renderer styles-*.js>"); process.exit(1); }
let s = readFileSync(p, "latin1");

if (s.includes("__zPaneStore")) { console.log("split-entry already injected — skip"); process.exit(0); }

function once(name, find, replace) {
  const idx = s.indexOf(find);
  if (idx < 0) { console.error(`[ABORT] ${name}: anchor not found`); process.exit(1); }
  if (s.indexOf(find, idx + 1) >= 0) { console.error(`[ABORT] ${name}: anchor not unique`); process.exit(1); }
  s = s.slice(0, idx) + replace + s.slice(idx + find.length);
}

// ---------- 0. 动态捕获 ----------
// splitPaneAt 函数名(store def 内)
const mSplit = s.match(/splitPane:\(t,n,r\)=>\{e\(\w+=>([\w$]+)\(e,t,n/);
if (!mSplit) { console.error("[ABORT] splitPaneAt fn not found in store def"); process.exit(1); }
const splitFn = mSplit[1];
console.log("splitPaneAt captured:", splitFn);
// workbench 组 store 变量名({activeGroupId,groups,sessionIndex},configureClientMode 注册串定位)
const mGroup = s.match(/([\w$]+)=Xa\(\)\(\(e,t\)=>\(\{\.\.\.([\w$]+),configureClientMode:/);
if (!mGroup) { console.error("[ABORT] group store def not found"); process.exit(1); }
const groupVar = mGroup[1];
if (s.indexOf(mGroup[0], s.indexOf(mGroup[0]) + 1) >= 0) { console.error("[ABORT] group store anchor not unique"); process.exit(1); }
console.log("group store captured:", groupVar, "(initial:", mGroup[2] + ")");
// 标签 store 工厂函数名(R1e 形态:tabs/pendingFileManagerTarget 初始键定位)
const mTabFac = s.match(/function ([\w$]+)\([^)]*\)\{return Xa\(\)\(\(t,n\)=>\(\{tabs:\[\],pendingFileManagerTarget:null/);
if (!mTabFac) { console.error("[ABORT] tab store factory not found"); process.exit(1); }
const tabFac = mTabFac[1];
console.log("tab store factory captured:", tabFac);

// ---------- 1. 主布局 store 三句柄 ----------
const storeHead = "var u4=Xa()(e=>({";
const headIdx = s.indexOf(storeHead);
if (headIdx < 0 || s.indexOf(storeHead, headIdx + 1) >= 0) {
  console.error("[ABORT] store head not found/unique"); process.exit(1);
}
{
  let depth = 0, i = headIdx + storeHead.length - 2;
  let inS = null, inT = false, inR = false;
  for (; i < s.length; i++) {
    const c = s[i], n = s[i + 1];
    if (inS) { if (c === "\\") { i++; continue } if (c === inS) inS = null; continue }
    if (c === '"' || c === "'") { inS = c; continue }
    if (c === "`") { inT = !inT; continue }
    if (c === "{" && n === "$" && s[i + 2] === "{") { inR = true; i += 2; continue }
    if (inT || inR) { if (inR && c === "}" && s[i - 1] === "}" && s[i - 2] === "$") inR = false; continue }
    if (c === "{") depth++;
    else if (c === "}") { depth--; if (depth === 0) break }
  }
  if (depth !== 0) { console.error("[ABORT] store brace scan failed"); process.exit(1); }
  const tail = s.slice(i, i + 3);
  if (tail !== `}))`) { console.error(`[ABORT] store tail unexpected: ${JSON.stringify(tail)}`); process.exit(1); }
  s = s.slice(0, i + 3) +
    `;globalThis.__zPaneStore=u4;globalThis.__zPaneSplit=${splitFn};globalThis.__zGroupStore=${groupVar};` +
    s.slice(i + 3);
  console.log("handles stashed: __zPaneStore + __zPaneSplit + __zGroupStore");
}

// ---------- 2. 标签 store 活实例句柄(B1e Provider 渲染期) ----------
// t.current 即 jT context value = 全部 useTabStore(MT hook) 读的活 store;
// 官方 window.__zcodeTabStoreE2E 有 Wa() 测试门控,生产拿不到,这里无条件挂。
once("tabstore.handle",
  `t.current||=${tabFac}(),(0,Q.useEffect)(`,
  `t.current||=${tabFac}(),globalThis.__zTabStoreLive=t.current,(0,Q.useEffect)(`,
);

// ---------- 3. p1t 悬浮动作层 ----------
// 3a. 渲染条件放宽(主窗格 onClosePane/workspaceBadge 均空时也能出分屏按钮)
once("overlay.condition",
  'n||t?(0,$.jsxs)(`div`,{"data-v4-pane-actions":`floating`',
  'n||t||globalThis.__zPaneStore?(0,$.jsxs)(`div`,{"data-v4-pane-actions":`floating`',
);

// 3b. 关闭按钮前插入两个分屏按钮
const btn = (dir, label, glyph) => {
  const body = [
    'let el=ev&&ev.currentTarget&&ev.currentTarget.closest("[data-pane-id]");',
    'let pid=el&&el.getAttribute("data-pane-id");',
    "let st=globalThis.__zPaneStore,sp=globalThis.__zPaneSplit;",
    "if(!pid||!st||!sp)return;",
    "let gs=globalThis.__zGroupStore&&globalThis.__zGroupStore.getState();",
    "if(gs&&gs.activeGroupId)return;",
    "let ss=st.getState();",
    'let has=function(n,id){return n.type==="leaf"?n.paneId===id:has(n.first,id)||has(n.second,id)};',
    "if(!has(ss.root,pid))return;",
    "let scope=ss.panes&&ss.panes[pid]&&ss.panes[pid].workspaceScope;",
    "if(!scope){let ts=globalThis.__zTabStoreLive&&globalThis.__zTabStoreLive.getState();",
    "let wp=ts&&ts.activeWorkspacePath,wi=ts&&ts.activeWorkspaceIdentity;",
    "if(!wp&&!wi)return;",
    "scope={workspacePath:wp};",
    "if(wi)scope.workspaceIdentity=wi;}",
    'ss.splitPane(pid,"' + dir + '",scope)',
  ].join("");
  return (
    'globalThis.__zPaneStore?(0,$.jsx)(X,{type:`button`,variant:`outline`,size:`icon-md`,"data-testid":"z-split-' + dir + '",' +
    "onClick:ev=>{" + body + "}," +
    'title:"Split ' + label + ' (this pane)","aria-label":"Split ' + label + '",' +
    'className:`pointer-events-auto bg-[var(--color-popover)] shadow-md`,children:"' + glyph + '"}):null,'
  );
};

const btnRow = btn("row", "right", "\\u2502\\u2502");
const btnCol = btn("column", "down", "\\u2550\\u2550");

// 注入前回归门:两枚按钮整串独立过 node --check 真解析器
{
  const probe = join(tmpdir(), "z-splitentry-probe.mjs");
  writeFileSync(probe, "var v=[" + btnRow + btnCol + "null];\n");
  try { execSync("node --check " + JSON.stringify(probe), { stdio: "pipe" }); }
  catch (e) { console.error("[ABORT] injected buttons fail node --check:\n" + String(e.stderr).slice(0, 500)); process.exit(1); }
  console.log("button strings pass standalone node --check");
}

once("overlay.buttons",
  't?(0,$.jsx)(X,{type:`button`,variant:`outline`,size:`icon-md`,"data-testid":Fze,',
  btnRow + btnCol +
  't?(0,$.jsx)(X,{type:`button`,variant:`outline`,size:`icon-md`,"data-testid":Fze,',
);

// ---------- 4. 侧栏会话路由:空窗格可被填充 ----------
// vbn(官方侧栏开会话路由)门槛 _bn(e) 放宽:焦点窗格有 panes 条目且
// sessionId 为空时也放行(官方不存在空窗格,原门槛使空窗格永远无法
// 从侧栏获得会话)。函数名/局部名全动态捕获,正则锚定 vbn 头部形状。
const mRoute = s.match(/function [\w$]+\(e,t\)\{let [\w$]+=[\w$]+\.getState\(\),([\w$]+)=[\w$]+\.getState\(\),[\w$]+=[\w$]+\(t\);if\(!([\w$]+)\.activeGroupId&&!\2\.sessionIndex\[[\w$]+\(t,t\.sessionId\)\]&&([\w$]+)\(e\)\)\{/);
if (!mRoute) { console.error("[ABORT] sidebar session router (vbn) not found"); process.exit(1); }
const routeHead = mRoute[0];
if (s.indexOf(routeHead, s.indexOf(routeHead) + 1) >= 0) { console.error("[ABORT] router anchor not unique"); process.exit(1); }
const routeVarU4 = mRoute[1], routeHasPanes = mRoute[3];
console.log("session router captured: u4-local=" + routeVarU4 + " gate=" + routeHasPanes);
const routeTail = "&&" + routeHasPanes + "(e)){";
if (!routeHead.endsWith(routeTail)) { console.error("[ABORT] router tail unexpected"); process.exit(1); }
once("session.router", routeHead,
  routeHead.slice(0, routeHead.length - routeTail.length) +
  "&&(" + routeHasPanes + "(e)||(" + routeVarU4 + ".panes[" + routeVarU4 + ".focusedPaneId]||{}).sessionId==null)){",
);

writeFileSync(p, s, "latin1");
console.log("split-entry v5 injected OK:", p, "| size:", s.length);
