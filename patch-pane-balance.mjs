#!/usr/bin/env node
// ============================================================
// ZCode 桌面端分屏均分补丁(渲染层 styles-*.js)
// ============================================================
// 语义:splitPaneAt / splitPaneAtSide 新建分屏时,整棵布局树重平衡——
// 每个 split 节点 ratio = 左子树叶数 / 总叶数,所有 pane 面积严格相等。
// 手动拖分隔条(replaceSplitRatio)不受影响。
// 用法:node patch-pane-balance.mjs <styles-*.js 路径>
// 幂等:已注入 __zpaneBalance 时跳过。
import { readFileSync, writeFileSync } from "node:fs";

const p = process.argv[2];
if (!p) { console.error("usage: node patch-pane-balance.mjs <renderer styles-*.js>"); process.exit(1); }
// latin1 = 字节保真读写:该 chunk 含非 UTF-8 字节,utf8 往返会静默损坏 100KB+;
// 锚点与注入代码均为纯 ASCII,latin1 下 1 字节=1 字符,往返无损。
let s = readFileSync(p, "latin1");

if (s.includes("__zpaneBalance")) { console.log("already patched — skip"); process.exit(0); }

// 自动探测混淆名(每个版本会变):splitPaneAt/splitPaneAtSide 的特征是
// `function X(e,t,n,r){if(!H1(e.root,t)||!H2(e))return e;`,root 替换助手 H3 从 return 里抓。
const fnRe = /function ([\w$]+)\(e,t,n,r\)\{if\(!([\w$]+)\(e\.root,t\)\|\|!([\w$]+)\(e\)\)return e;/g;
const splitFns = [];
let m;
while ((m = fnRe.exec(s))) splitFns.push({ name: m[1], index: m.index });
if (splitFns.length !== 2) {
  console.error(`[ABORT] expected exactly 2 split functions, found ${splitFns.length}`);
  process.exit(1);
}
const [fnAt, fnSide] = splitFns;
const rootHelper = (() => {
  const seg = s.slice(fnAt.index, fnAt.index + 900).match(/return\{root:([\w$]+)\(e\.root,t,([a-z])\)/);
  if (!seg) { console.error("[ABORT] root helper not found near first split fn"); process.exit(1); }
  return { name: seg[1], tempAt: seg[2] };
})();
const segSide = s.slice(fnSide.index, fnSide.index + 900).match(/return\{root:([\w$]+)\(e\.root,t,([a-z])\)/);
if (!segSide || segSide[1] !== rootHelper.name) {
  console.error("[ABORT] second split fn return shape mismatch"); process.exit(1);
}

const HELPER =
  "function __zpaneBalance(n){if(n.type!==`split`)return n;" +
  "var c=function(x){return x.type===`split`?c(x.first)+c(x.second):1};" +
  "var f=__zpaneBalance(n.first),i=__zpaneBalance(n.second);" +
  "return{...n,ratio:c(f)/(c(f)+c(i)),first:f,second:i}}";

function once(name, find, replace) {
  const idx = s.indexOf(find);
  if (idx < 0) { console.error(`[ABORT] ${name}: anchor not found`); process.exit(1); }
  if (s.indexOf(find, idx + 1) >= 0) { console.error(`[ABORT] ${name}: anchor not unique`); process.exit(1); }
  s = s.slice(0, idx) + replace + s.slice(idx + find.length);
}

// 注入重平衡助手,并把两个入口的 root 包上 __zpaneBalance(仅新建分屏路径)
once("helper-inject", `function ${fnAt.name}(e,t,n,r){`, HELPER + `function ${fnAt.name}(e,t,n,r){`);
once(`${fnAt.name}-return`,
  `return{root:${rootHelper.name}(e.root,t,${rootHelper.tempAt}),panes:{...e.panes,[i]:r},focusedPaneId:i}}`,
  `return{root:__zpaneBalance(${rootHelper.name}(e.root,t,${rootHelper.tempAt})),panes:{...e.panes,[i]:r},focusedPaneId:i}}`);
once(`${fnSide.name}-return`,
  `return{root:${rootHelper.name}(e.root,t,${segSide[2]}),panes:{...e.panes,[i]:r},focusedPaneId:i}}`,
  `return{root:__zpaneBalance(${rootHelper.name}(e.root,t,${segSide[2]})),panes:{...e.panes,[i]:r},focusedPaneId:i}}`);

writeFileSync(p, s, "latin1");
console.log("patched OK:", p, "| size:", s.length);
