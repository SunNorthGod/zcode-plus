// XFo 卫语句子代理端口场景仿真:三种端口形态 × 两轮刷新,验证防抖与重注册
import { readFileSync } from "node:fs";
import vm from "node:vm";

const all = readFileSync(process.argv[2] ?? "C:/Users/29596/Desktop/Project/Zcode/zcode-patch/v6c.cjs", "utf8");
// 提取改写后的 XFo 函数源码并 eval
const i = all.indexOf("async function XFo(e){");
let depth = 0, end = i;
for (let j = i; j < all.length; j++) {
  if (all[j] === "{") depth++;
  else if (all[j] === "}") { depth--; if (depth === 0) { end = j + 1; break; } }
}
const xfoSrc = all.slice(i, end);
// XFo 引用的依赖:YFo(签名)、$bt(注册)、__zcodeMcpFilter、Swt、ZFo、Sr —— 用桩替代
const sandbox = `
  ${xfoSrc}
  globalThis.__xfocalls = { yfo: 0, reg: 0, unreg: 0 };
  globalThis.YFo = (tools) => { __xfocalls.yfo++; return tools.map(t=>t.serverName+"/"+t.toolName).sort().join("|"); };
  globalThis.$bt = (registry, port, filtered, opts) => { __xfocalls.reg++; return filtered.map(t=>t.toolName); };
  globalThis.__zcodeMcpFilter = function(t){ let w=this&&this.__zcodeMcpWanted; if(!w||w.size===0)return[]; return t.filter(d=>w.has(d.serverName+"\u0001"+d.toolName)); };
  globalThis.Swt = () => new Set();
  globalThis.ZFo = () => new Map();
  globalThis.Sr = () => ({});
`;
const ctx = { console };
vm.createContext(ctx);
vm.runInContext(sandbox, ctx);

const mkRuntime = (port) => ({
  mcpPort: port,
  mcpToolsRegistered: true,
  mcpToolListRevision: 5,
  mcpToolsSignature: "stale",
  registeredMcpToolNames: new Set(["old_tool"]),
  __zcodeMcpWanted: new Set(["srv/wind"]),
  registry: { unregister(n) { ctx.__xfocalls.unreg++; }, register() {} },
  config: { mcp: { servers: {} } },
  invalidateToolCache() {},
  logger: { info() {}, warn() {} },
});

const portWithRevision = {
  toolListRevision: () => 9,
  listTools: async () => [{ serverName: "srv", toolName: "wind" }],
};
const subagentPort = { // OFo 借用包装:无 toolListRevision
  listTools: async () => [{ serverName: "srv", toolName: "wind" }],
};

const scenarios = [
  ["native port, rev changed", portWithRevision, true, 1],
  ["native port, rev same", portWithRevision, false, 0],
  ["subagent port (no rev), first", subagentPort, true, 1],
  ["subagent port (no rev), second (signature same → debounce)", subagentPort, false, 0],
];

// 子端口防抖场景必须复用同一 runtime:第一轮刷新会把签名写入 mcpToolsSignature,
// 第二轮签名相同 → 早退。新建 runtime 会把签名重置为 stale,测不出防抖。
const sharedSub = mkRuntime(subagentPort);
let pass = 0;
for (const [name, port, expectRereg] of scenarios) {
  ctx.__xfocalls.reg = 0; ctx.__xfocalls.unreg = 0;
  const rt = name.startsWith("subagent") ? sharedSub : mkRuntime(port);
  if (name.includes("rev same")) rt.mcpToolListRevision = 9; // 同 revision 早退
  await vm.runInContext("XFo.call(globalThis.__rt, {})", Object.assign(ctx, { __rt: rt }));
  const didRereg = ctx.__xfocalls.reg > 0;
  const ok = didRereg === expectRereg;
  console.log((ok ? "OK  " : "FAIL") + " " + name, "| re-reg:", ctx.__xfocalls.reg, "unreg:", ctx.__xfocalls.unreg, "| wanted-filtered registered");
  if (ok) pass++;
}
console.log(pass === scenarios.length ? "ALL PASS" : "SOME FAILED");
process.exit(pass === scenarios.length ? 0 : 1);
