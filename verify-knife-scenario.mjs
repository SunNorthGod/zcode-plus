// 刀会话白名单场景复现:allowlist = 内建名 + mcp 注册名(vendor 正确形态)时 execute 必须放行
import { readFileSync } from "node:fs";
import vm from "node:vm";

const target = process.argv[2] || "v7.cjs";
const all = readFileSync(target, "utf8");
const L = all.split("\n")[14627];
const code = L.slice(L.indexOf("function __zcodeMcpSearchEntry(rt){"), L.indexOf("async function KFo(e){"));

function extractFn(name) {
  const lines = all.split("\n");
  for (const ln of lines) {
    const i = ln.indexOf(`function ${name}(`);
    if (i >= 0) {
      let d = 0, inS = null;
      for (let j = i; j < ln.length; j++) {
        const c = ln[j];
        if (inS) { if (c === "\\") { j++; continue } if (c === inS) inS = null; continue }
        if (c === '"' || c === "'") { inS = c; continue }
        if (c === "{") d++; else if (c === "}") { d--; if (d === 0) return ln.slice(i, j + 1); }
      }
    }
  }
  return null;
}

// 动态捕获 keepNames
const mA = all.match(/\(([\w$]+),"toMcpToolName"\)/);
const mN = all.match(/\(([\w$]+),"normalizeToolNameAlias"\)/);
const mK = all.match(/\(([\w$]+),"toRegisteredMcpToolName"\)/);
const mN8 = all.match(/\(([\w$]+),"toModelVisibleMcpNamePart"\)/);
const fnSrc = [mA[1], mN[1], mK[1], mN8[1]].map(extractFn).filter(Boolean).join("\n");

const P = { capability: "cap", outputSchema: {}, permission: {}, resultBudget: {}, timeout: {}, cancellation: {}, trace: {}, metadata: {} };
// 刀会话真实形态:q4a 构造的 allowlist = 父全部非 mcp 工具名 + mcp 注册名
const fake = {
  registry: { get: (n) => (n === "Read" ? P : null), register: () => {} },
  config: { toolAllowlist: ["Read", "Bash", "Edit", "mcp__ida__decompile", "mcp__ida__list_instances"], toolDisallowlist: undefined },
  mcpPort: { listTools: async () => [{ serverName: "ida", toolName: "decompile", description: "dec" }] },
};
const ctx = {
  console,
  UCn: (n, d, p, c, o) => ({ handler: async (a, c) => ({ content: [{ type: "text", text: "RAN " + n }] }) }),
};
vm.createContext(ctx);
vm.runInContext(fnSrc, ctx);
vm.runInContext(code + ";globalThis.__entry=__zcodeMcpSearchEntry", ctx);

const e = ctx.__entry(fake);
const r = await e.handler({ tool: "ida/decompile", args: { addr: "0x1" } }, {});
console.log("knife-scenario execute:", r.summary, "|", r.tools?.[0]);
process.exit(/returned/.test(r.summary) ? 0 : 1);
