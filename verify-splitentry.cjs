// split-entry v4 onClick 语义仿真:从打好补丁的 chunk 里抽真串,vm 实跑断言
// 用法:node verify-splitentry.cjs <styles-*.js> [版本号标签]
const fs = require("fs"), vm = require("vm");
const p = process.argv[2] ?? "asar-work/app/out/renderer/assets/styles-CQuzX8si.js";
const s = fs.readFileSync(p, "latin1");

function extractOnClick(dir) {
  const anchor = `"data-testid":"z-split-` + dir + `",`;
  const i = s.indexOf(anchor);
  if (i < 0) throw new Error("button not found: " + dir);
  const j = s.indexOf("onClick:ev=>{", i);
  const end = s.indexOf("},title:", j);
  return s.slice(j + "onClick:".length, end + 1); // ev=>{...} 含闭括号
}

// vm 环境:模拟官方 store 语义(Zvt 不参与,只验按钮的分派与 scope 构造)
function makeEnv({ root, panes, tabState, groupState, pid }) {
  const calls = [];
  const g = {
    __zPaneStore: {
      getState: () => ({
        root, panes, focusedPaneId: pid ?? "workspace-main",
        splitPane: (pid, dir, scope) => calls.push([pid, dir, scope]),
      }),
    },
    __zPaneSplit: function () {},
    __zGroupStore: groupState === undefined ? undefined : { getState: () => groupState },
    __zTabStoreLive: tabState === undefined ? undefined : { getState: () => tabState },
  };
  const ctx = vm.createContext({ ...g, console });
  const fn = (code) => vm.runInContext("(" + code + ")", ctx);
  const ev = { currentTarget: { closest: () => ({ getAttribute: () => pid ?? "workspace-main" }) } };
  return { calls, fn, ev, g };
}

// ---------- 按钮场景 ----------
const leafMain = { type: "leaf", paneId: "workspace-main" };
let fail = 0;
function expect(name, cond, detail) {
  console.log((cond ? "PASS " : "FAIL ") + name + (cond ? "" : " | " + detail));
  if (!cond) fail++;
}

// 场景 1:主窗格 + 标签 store 活实例 → scope = {workspacePath, workspaceIdentity}
{
  const e = makeEnv({ root: leafMain, panes: {}, tabState: { activeWorkspacePath: "C:/proj", activeWorkspaceIdentity: "ident-1" }, groupState: { activeGroupId: null, groups: {} } });
  e.fn(extractOnClick("row"))(e.ev);
  const c = e.calls[0];
  expect("main pane: splitPane called once", e.calls.length === 1, JSON.stringify(e.calls));
  expect("main pane: pid+dir", c && c[0] === "workspace-main" && c[1] === "row", JSON.stringify(c));
  expect("main pane: scope from tab store", c && c[2] && c[2].workspacePath === "C:/proj" && c[2].workspaceIdentity === "ident-1", JSON.stringify(c && c[2]));
}
// 场景 2:组模式(activeGroupId 非空)→ no-op
{
  const e = makeEnv({ root: leafMain, panes: {}, tabState: { activeWorkspacePath: "C:/proj" }, groupState: { activeGroupId: "g1", groups: {} } });
  e.fn(extractOnClick("column"))(e.ev);
  expect("group mode: no-op", e.calls.length === 0, JSON.stringify(e.calls));
}
// 场景 3:非主窗格带 binding → scope = 该窗格 workspaceScope 原样
{
  const root = { type: "split", id: "s1", direction: "row", ratio: 0.5, first: { type: "leaf", paneId: "workspace-main" }, second: { type: "leaf", paneId: "pane-1" } };
  const scopeObj = { workspacePath: "C:/other", remoteSessionId: "r-9" };
  const e = makeEnv({ root, panes: { "pane-1": { workspaceScope: scopeObj, sessionId: "ses-1" } }, tabState: { activeWorkspacePath: "C:/proj" }, groupState: { activeGroupId: null, groups: {} }, pid: "pane-1" });
  e.fn(extractOnClick("row"))(e.ev);
  const c = e.calls[0];
  expect("bound pane: called once", e.calls.length === 1, JSON.stringify(e.calls));
  expect("bound pane: scope is pane workspaceScope verbatim", c && c[2] === scopeObj, JSON.stringify(c && c[2]));
}
// 场景 4:pid 不在主布局树 → no-op
{
  const e = makeEnv({ root: leafMain, panes: {}, tabState: { activeWorkspacePath: "C:/proj" }, groupState: { activeGroupId: null, groups: {} } });
  const ev2 = { currentTarget: { closest: () => ({ getAttribute: () => "pane-9" }) } };
  e.fn(extractOnClick("row"))(ev2);
  expect("unknown pid: no-op", e.calls.length === 0, JSON.stringify(e.calls));
}
// 场景 5:无句柄(标签 store 没起来)且无窗格 binding → 安全 no-op
{
  const e = makeEnv({ root: leafMain, panes: {}, tabState: undefined, groupState: { activeGroupId: null, groups: {} } });
  e.fn(extractOnClick("row"))(e.ev);
  expect("no tab store: no-op without crash", e.calls.length === 0, JSON.stringify(e.calls));
}
// 场景 6:活动工作区为空 → no-op(不分出无工作区窗格)
{
  const e = makeEnv({ root: leafMain, panes: {}, tabState: { activeWorkspacePath: null, activeWorkspaceIdentity: null }, groupState: { activeGroupId: null, groups: {} } });
  e.fn(extractOnClick("row"))(e.ev);
  expect("empty workspace: no-op", e.calls.length === 0, JSON.stringify(e.calls));
}

// ---------- 侧栏会话路由(vbn)vm 场景 ----------
// 从产物抽改过的 vbn 原文与全部自由变量名,mock 官方依赖实跑
function extractRouter() {
  const m = s.match(/&&\(([\w$]+)\(e\)\|\|\(([\w$]+)\.panes\[\2\.focusedPaneId\]\|\|\{\}\)\.sessionId==null\)\)\{/);
  if (!m) throw new Error("router patch marker not found");
  const condIdx = s.indexOf(m[0]);
  const fnIdx = s.slice(0, condIdx).lastIndexOf("function ");
  if (condIdx - fnIdx > 400) throw new Error("router function head backtrack too far");
  // 字符串感知括号扫描:从函数体第一个 { 到配平
  let depth = 0, i = s.indexOf("{", fnIdx), started = false, inS = null, inT = false, inR = false;
  for (; i < s.length; i++) {
    const c = s[i], n = s[i + 1];
    if (inS) { if (c === "\\") { i++; continue } if (c === inS) inS = null; continue }
    if (c === '"' || c === "'") { inS = c; continue }
    if (c === "`") { inT = !inT; continue }
    if (c === "{" && n === "$" && s[i + 2] === "{") { inR = true; i += 2; continue }
    if (inT || inR) { if (inR && c === "}" && s[i - 1] === "}" && s[i - 2] === "$") inR = false; continue }
    if (c === "{") { depth++; started = true }
    else if (c === "}") { depth--; if (started && depth === 0) break }
  }
  const src = s.slice(fnIdx, i + 1);
  if (!src.endsWith("}")) throw new Error("router brace scan failed");
  // 自由变量名:两个 getState、条件里的 sessionIndex 键函数与门槛函数
  const head = src.match(/let ([\w$]+)=([\w$]+)\.getState\(\),([\w$]+)=([\w$]+)\.getState\(\),([\w$]+)=([\w$]+)\(t\);/);
  const jIFn = (src.match(/sessionIndex\[([\w$]+)\(t,t\.sessionId\)\]/) || [])[1];
  const gateFn = m[1], gbnFn = head[6], u4Name = head[4], jiName = head[2];
  const eytFn = (src.match(/([\w$]+)\(R,t,t\.sessionId\)/.test(src) ? /([\w$]+)\([\w$]+,t,t\.sessionId\)/ : /([\w$]+)\([\w$]+,t,t\.sessionId\)/) || [])[1];
  const focusIdxFn = (src.match(/\?\?([\w$]+)\(R\)/) || [])[1] || (src.match(/\?\?([\w$]+)\([\w$]+\)/) || [])[1];
  const logName = (src.match(/([\w$]+)\.debug\(/) || [])[1];
  if (!head || !jIFn || !eytFn || !focusIdxFn || !logName) throw new Error("router free-var capture failed");
  return { src, jiName, u4Name, gbnFn, gateFn, jIFn, eytFn, focusIdxFn, logName };
}

function routerRun() {
  const { src, jiName, u4Name, gbnFn, gateFn, jIFn, eytFn, focusIdxFn, logName } = extractRouter();
  const uI = (e) => (e && e.workspaceIdentity && e.workspaceIdentity.trim()) || (e && e.workspacePath);
  function makeCtx(u4State, jiState) {
    const spies = { focus: [], replace: [], sidebar: [] };
    const sandbox = {
      uI,
      [jiName]: { getState: () => jiState },
      [u4Name]: { getState: () => u4State },
      [gbnFn]: ({ sessionId, ...rest }) => ({ workspaceScope: rest, sessionId }),
      [eytFn]: (st, scope, sid) => { for (const [k, v] of Object.entries(st.panes)) if (v.sessionId === sid && uI(v.workspaceScope) === uI(scope)) return k; return null },
      [focusIdxFn]: (st) => st.focusedPaneId,
      [jIFn]: (b, sid) => uI(b) + "::" + sid,
      [gateFn]: (e) => { const st = u4State; return Object.keys(st.panes).length === 0 ? false : !e || Object.values(st.panes).some((p) => p.sessionId === e.sessionId && uI(p.workspaceScope) === uI(e.workspaceScope)); },
      [logName]: { debug() {}, warn() {} },
    };
    u4State.focusPane = (id) => spies.focus.push(id);
    u4State.replacePaneBinding = (id, b) => spies.replace.push([id, b]);
    jiState.openSessionFromSidebar = (b) => spies.sidebar.push(b);
    const ctx = vm.createContext(sandbox);
    return { fn: vm.runInContext("(" + src + ")", ctx), spies };
  }
  return { makeCtx };
}
{
  const { makeCtx } = routerRun();
  const W = { workspacePath: "C:/proj" };
  const A = { workspacePath: "C:/proj", sessionId: "ses-A" };
  const B = { workspacePath: "C:/proj", sessionId: "ses-B" };
  // S1(核心):空窗格聚焦,点侧栏会话 B → replacePaneBinding 填入
  {
    const u4s = { panes: { "pane-1": { workspaceScope: W, sessionId: null } }, focusedPaneId: "pane-1" };
    const { fn, spies } = makeCtx(u4s, { activeGroupId: null, sessionIndex: {} });
    fn(A, B);
    const r = spies.replace[0];
    expect("router: empty pane filled", spies.replace.length === 1 && r[0] === "pane-1" && r[1].sessionId === "ses-B" && r[1].workspaceScope.workspacePath === "C:/proj", JSON.stringify(spies));
    expect("router: sidebar open still called", spies.sidebar.length === 1, JSON.stringify(spies.sidebar));
  }
  // S2:无额外窗格 → 不动,仅常规打开
  {
    const u4s = { panes: {}, focusedPaneId: "workspace-main" };
    const { fn, spies } = makeCtx(u4s, { activeGroupId: null, sessionIndex: {} });
    fn(A, B);
    expect("router: no panes untouched", spies.replace.length === 0 && spies.focus.length === 0, JSON.stringify(spies));
  }
  // S3:点的会话已在窗格 → 聚焦该窗格
  {
    const u4s = { panes: { "pane-2": { workspaceScope: W, sessionId: "ses-B" } }, focusedPaneId: "pane-1" };
    // panes 需含 pane-1 才进内层;S3 走 eyt 分支在前,无需 pane-1 条目
    const { fn, spies } = makeCtx(u4s, { activeGroupId: null, sessionIndex: {} });
    fn(A, B);
    expect("router: existing pane focused", spies.focus.length === 1 && spies.focus[0] === "pane-2" && spies.replace.length === 0, JSON.stringify(spies));
  }
  // S4:组模式 → 完全走官方路径(只 sidebar)
  {
    const u4s = { panes: { "pane-1": { workspaceScope: W, sessionId: null } }, focusedPaneId: "pane-1" };
    const { fn, spies } = makeCtx(u4s, { activeGroupId: "g1", sessionIndex: {} });
    fn(A, B);
    expect("router: group mode official-only", spies.replace.length === 0 && spies.focus.length === 0 && spies.sidebar.length === 1, JSON.stringify(spies));
  }
  // S5:焦点在主窗格 → 不替换
  {
    const u4s = { panes: { "pane-1": { workspaceScope: W, sessionId: "ses-A" } }, focusedPaneId: "workspace-main" };
    const { fn, spies } = makeCtx(u4s, { activeGroupId: null, sessionIndex: {} });
    fn(A, B);
    expect("router: main-pane focus no replace", spies.replace.length === 0, JSON.stringify(spies));
  }
  console.log("SPLITENTRY ROUTER VM done");
}

console.log(fail === 0 ? "SPLITENTRY VM: ALL PASS" : "SPLITENTRY VM: " + fail + " FAILED");
process.exit(fail === 0 ? 0 : 1);
