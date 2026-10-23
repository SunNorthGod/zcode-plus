#!/usr/bin/env node
// ============================================================
// ZCode 桌面端分屏创建入口补丁 v3(渲染层 styles-*.js)
// ============================================================
// v1 症状:按钮点击无反应且布局零变化(疑按钮未渲染或点击未达 store)。
// v2 症状:点按钮即崩 fbn "reading 'workspaceIdentity'"。
// v3 修正:官方 splitPane 的第三参 workspaceScope 不可缺——传 undefined 会
//   造出 {workspaceScope:undefined} 的坏窗格,fbn 渲染时读 workspaceIdentity
//   即崩(官方该方法无 UI 调用方,故从未被裸调过)。scope 解析链:本窗格绑定
//   → 组 primaryBinding → 根 primaryBinding;无根布局时对组布局复刻同一 split。
//   渲染层 console 不进 ~/.zcode/v2/logs,挂载/点击日志对远程定位无用,v3 移除。
//   onClick 体用数组拼接构造,注入前先独立过 node --check 真解析器,
//   括号配平错误到此为止,进不了产物。
// 其余同 v2:store 句柄 / data-pane-id 就近定位 / <4 守卫官方兜底 /
// 均分由 __zpaneBalance 补丁自动生效。幂等:含 __zPaneStore 即跳过。
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

// ---------- 0. 动态捕获官方 splitPaneAt 函数名 ----------
const mSplit = s.match(/splitPane:\(t,n,r\)=>\{e\(\w+=>([\w$]+)\(e,t,n/);
if (!mSplit) { console.error("[ABORT] splitPaneAt fn not found in store def"); process.exit(1); }
const splitFn = mSplit[1];
console.log("splitPaneAt captured:", splitFn);

// ---------- 1. store + split 函数双句柄 ----------
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
  s = s.slice(0, i + 3) + `;globalThis.__zPaneStore=u4;globalThis.__zPaneSplit=${splitFn};` + s.slice(i + 3);
  console.log("handles stashed: __zPaneStore + __zPaneSplit");
}

// ---------- 2. p1t 悬浮动作层 ----------
// 2a. 渲染条件放宽(主窗格 onClosePane/workspaceBadge 均空时也能出分屏按钮)
once("overlay.condition",
  'n||t?(0,$.jsxs)(`div`,{"data-v4-pane-actions":`floating`',
  'n||t||globalThis.__zPaneStore?(0,$.jsxs)(`div`,{"data-v4-pane-actions":`floating`',
);

// 2b. 关闭按钮前插入两个分屏按钮
const btn = (dir, label, glyph) => {
  const body = [
    'let el=ev&&ev.currentTarget&&ev.currentTarget.closest("[data-pane-id]");',
    'let pid=el&&el.getAttribute("data-pane-id");',
    "let st=globalThis.__zPaneStore,sp=globalThis.__zPaneSplit;",
    "if(!pid||!st||!sp)return;",
    "let ss=st.getState(),gid=ss.activeGroupId;",
    "let pb=gid&&ss.groups&&ss.groups[gid]?ss.groups[gid].primaryBinding:ss.primaryBinding;",
    "let scope=ss.panes&&ss.panes[pid]&&ss.panes[pid].workspaceScope||pb&&pb.workspaceScope;",
    "if(!scope)return;",
    'if(!gid||!ss.groups||!ss.groups[gid]){ss.splitPane(pid,"' + dir + '",scope);return}',
    "let grp=ss.groups[gid];",
    'let ns=sp(grp,pid,"' + dir + '",{workspaceScope:scope,sessionId:null});',
    "if(ns!==grp)st.setState(function(prev){return{groups:Object.assign({},prev.groups,{[gid]:ns})}})",
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

writeFileSync(p, s, "latin1");
console.log("split-entry v3 injected OK:", p, "| size:", s.length);
