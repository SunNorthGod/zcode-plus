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

console.log(fail === 0 ? "SPLITENTRY VM: ALL PASS" : "SPLITENTRY VM: " + fail + " FAILED");
process.exit(fail === 0 ? 0 : 1);
