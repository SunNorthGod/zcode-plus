#!/usr/bin/env node
// ============================================================
// ZCode 桌面端分屏创建入口补丁 v2(渲染层 styles-*.js)
// ============================================================
// v1 症状:按钮点击无反应且布局零变化(疑按钮未渲染或点击未达 store)。
// v2 变化:
//   1. 可观测性:p1t 挂载与按钮点击均打 console.log(渲染层 console
//      转发进 ~/.zcode/v2/logs,可远程定位断点);
//   2. 双模式分派:无 activeGroupId → 官方 splitPane(根布局);
//      有 activeGroupId(workbench 组) → 对 groups[gid] 复刻同一 split
//      (官方 split 函数动态捕获自 store 定义,经 __zPaneSplit 暴露);
//   3. split 函数名动态捕获(每版改名,Zvt 为 3163 名),捕获失败即中止。
// 其余同 v1:store 句柄 / data-pane-id 就近定位 / <4 守卫官方兜底 /
// 均分由 __zpaneBalance 补丁自动生效。幂等:含 __zPaneStore 即跳过。
// 用法:node patch-pane-splitentry.mjs <styles-*.js 路径>
import { readFileSync, writeFileSync } from "node:fs";

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
// 2a. 挂载观测 + 渲染条件放宽
once("overlay.condition",
  'function p1t({title:e,onClosePane:t,workspaceBadge:n}){let{intl:r}=q();',
  'function p1t({title:e,onClosePane:t,workspaceBadge:n}){let{intl:r}=q();try{console.log("[z-split] overlay render store="+!!globalThis.__zPaneStore+" badge="+(!!n)+" close="+(!!t))}catch(z1){};',
);
once("overlay.condition2",
  'n||t?(0,$.jsxs)(`div`,{"data-v4-pane-actions":`floating`',
  'n||t||globalThis.__zPaneStore?(0,$.jsxs)(`div`,{"data-v4-pane-actions":`floating`',
);

// 2b. 关闭按钮前插入两个分屏按钮(双模式分派 + 点击观测)
const btn = (dir, label, glyph) =>
  'globalThis.__zPaneStore?(0,$.jsx)(X,{type:`button`,variant:`outline`,size:`icon-md`,"data-testid":"z-split-' + dir + '",' +
  'onClick:ev=>{try{let el=ev&&ev.currentTarget&&ev.currentTarget.closest("[data-pane-id]");let pid=el&&el.getAttribute("data-pane-id");' +
  'let st=globalThis.__zPaneStore,sp=globalThis.__zPaneSplit;' +
  'if(!pid||!st||!sp){console.warn("[z-split] missing pid/store/fn",!!pid,!!st,!!sp);return}' +
  'let ss=st.getState(),gid=ss.activeGroupId;' +
  'if(!gid){ss.splitPane(pid,"' + dir + '");console.log("[z-split] root split ok",pid);return}' +
  'let grp=ss.groups&&ss.groups[gid];if(!grp){console.warn("[z-split] group missing",gid);ss.splitPane(pid,"' + dir + '");return}' +
  'let ns=sp(grp,pid,"' + dir + '",{workspaceScope:void 0,sessionId:null});' +
  'if(ns!==grp)st.setState(function(prev){return{groups:Object.assign({},prev.groups,{[gid]:ns})}});' +
  'console.log("[z-split] group split",gid,pid,ns!==grp)}catch(z2){console.warn("[z-split] error",z2&&z2.message)}},' +
  'title:"Split ' + label + ' (this pane)","aria-label":"Split ' + label + '",' +
  'className:`pointer-events-auto bg-[var(--color-popover)] shadow-md`,children:"' + glyph + '"}):null,';

once("overlay.buttons",
  't?(0,$.jsx)(X,{type:`button`,variant:`outline`,size:`icon-md`,"data-testid":Fze,',
  btn("row", "right", "\\u2502\\u2502") + btn("column", "down", "\\u2550\\u2550") +
  't?(0,$.jsx)(X,{type:`button`,variant:`outline`,size:`icon-md`,"data-testid":Fze,',
);

writeFileSync(p, s, "latin1");
console.log("split-entry v2 injected OK:", p, "| size:", s.length);
