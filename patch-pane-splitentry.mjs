#!/usr/bin/env node
// ============================================================
// ZCode 桌面端分屏创建入口补丁(渲染层 styles-*.js)
// ============================================================
// 背景:官方 3.16.1 起删除了拖拽分屏的落点组件;store 的 splitPane 等
// 动作全部保留但无 UI 调用方。本补丁自建创建入口(主人点名)。
// 做法(两处注入,全部 ASCII 源码,图标用 \u 转义):
//   1. 布局 store(var u4=Xa()(e=>({...})))创建语句后挂
//      globalThis.__zPaneStore=u4 供跨模块访问(zustand hook 自带 getState);
//   2. p1t(窗格悬浮动作层,每个窗格一个):
//      渲染条件放宽(store 句柄存在即渲染容器,主窗格也能分);
//      关闭按钮前插入「向右/向下分屏」两按钮——从 DOM 最近祖先
//      [data-pane-id](官方窗格框架 lbn 自带)取本窗格 paneId,
//      调 splitPane(pid,'row'|'column')。
//      pane 数量守卫(<4)由官方 Zvt 原逻辑兜底;新窗格由
//      __zpaneBalance(均分补丁)自动均衡。
// 幂等:已含 __zPaneStore 即跳过;锚点必须唯一命中否则整体中止不写盘。
// 用法:node patch-pane-splitentry.mjs <styles-*.js 路径>
import { readFileSync, writeFileSync } from "node:fs";

const p = process.argv[2];
if (!p) { console.error("usage: node patch-pane-splitentry.mjs <renderer styles-*.js>"); process.exit(1); }
// latin1 = 字节保真读写(该 chunk 含非 UTF-8 字节,utf8 往返静默损坏)
let s = readFileSync(p, "latin1");

if (s.includes("__zPaneStore")) { console.log("split-entry already injected — skip"); process.exit(0); }

function once(name, find, replace) {
  const idx = s.indexOf(find);
  if (idx < 0) { console.error(`[ABORT] ${name}: anchor not found`); process.exit(1); }
  if (s.indexOf(find, idx + 1) >= 0) { console.error(`[ABORT] ${name}: anchor not unique`); process.exit(1); }
  s = s.slice(0, idx) + replace + s.slice(idx + find.length);
}

// ---------- 1. store 全局句柄 ----------
// 定位 var u4=Xa()(e=>({...})) 的语句结尾:字符串感知的花括号配平扫描
const storeHead = "var u4=Xa()(e=>({";
const headIdx = s.indexOf(storeHead);
if (headIdx < 0 || s.indexOf(storeHead, headIdx + 1) >= 0) {
  console.error("[ABORT] store head not found/unique"); process.exit(1);
}
{
  let depth = 0, i = headIdx + storeHead.length - 2; // 从 e=>({ 的 '{' 起
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
  // i 指向 store 对象收尾 '}';其后应为 '))' 关闭 e=>(...) 与 Xa()(...)
  const tail = s.slice(i, i + 3);
  if (tail !== `}))`) { console.error(`[ABORT] store tail unexpected: ${JSON.stringify(tail)}`); process.exit(1); }
  const insertAt = i + 3;
  s = s.slice(0, insertAt) + ";globalThis.__zPaneStore=u4;" + s.slice(insertAt);
  console.log("store handle stashed: globalThis.__zPaneStore=u4");
}

// ---------- 2. p1t 悬浮动作层 ----------
// 2a. 渲染条件放宽(主窗格 onClosePane/workspaceBadge 均空时也能出分屏按钮)
once("overlay.condition",
  'n||t?(0,$.jsxs)(`div`,{"data-v4-pane-actions":`floating`',
  'n||t||globalThis.__zPaneStore?(0,$.jsxs)(`div`,{"data-v4-pane-actions":`floating`',
);

// 2b. 关闭按钮前插入两个分屏按钮
const btn = (dir, label, glyph) =>
  'globalThis.__zPaneStore?(0,$.jsx)(X,{type:`button`,variant:`outline`,size:`icon-md`,"data-testid":"z-split-' + dir + '",' +
  'onClick:ev=>{let g=ev&&ev.currentTarget&&ev.currentTarget.closest("[data-pane-id]");let pid=g&&g.getAttribute("data-pane-id");pid&&globalThis.__zPaneStore.getState().splitPane(pid,"' + dir + '")},' +
  'title:"Split ' + label + ' (this pane)","aria-label":"Split ' + label + '",' +
  'className:`pointer-events-auto bg-[var(--color-popover)] shadow-md`,children:"' + glyph + '"}):null,';

once("overlay.buttons",
  't?(0,$.jsx)(X,{type:`button`,variant:`outline`,size:`icon-md`,"data-testid":Fze,',
  btn("row", "right", "\\u2502\\u2502") + btn("column", "down", "\\u2550\\u2550") +
  't?(0,$.jsx)(X,{type:`button`,variant:`outline`,size:`icon-md`,"data-testid":Fze,',
);

writeFileSync(p, s, "latin1");
console.log("split-entry injected OK:", p, "| size:", s.length);
