// v7 ToolSearch 无状态网关回归:node verify-v7.mjs [bundle 路径,默认已装 zcode.cjs]
// 覆盖:entry 创建、outputSchema、handler 六种返回形态(catalog/keyword-filter/
// inspect/execute/blocked-by-allowlist/zero-server)与 UCn execute 路径。
import { readFileSync } from "node:fs";
import vm from "node:vm";

const target = process.argv[2] ?? "C:/Program Files/ZCode/resources/glm/zcode.cjs";
const all = readFileSync(target, "utf8");
const L = all.split("\n")[14627];
const iF = L.indexOf("function __zcodeMcpSearchEntry(rt){");
const iK = L.indexOf("async function KFo(e){");
if (iF < 0 || iK < 0) { console.error("anchors missing"); process.exit(1); }
const code = L.slice(iF, iK);

// 1) 括号机械平衡
let d = 0, inS = null, inT = false, inR = false;
for (let i = 0; i < code.length; i++) {
  const c = code[i], n = code[i + 1];
  if (inS) { if (c === "\\") { i++; continue } if (c === inS) inS = null; continue }
  if (c === '"' || c === "'") { inS = c; continue }
  if (c === "`") { inT = !inT; continue }
  if (c === "{" && n === "$" && code[i + 2] === "{") { inR = true; continue }
  if (inT || inR) { if (c === "}" && code[i - 1] === "}" && code[i - 2] === "$") inR = false; continue }
  if (c === "{") d++; else if (c === "}") d--;
}
console.log("brace-balance:", d);
if (d !== 0) { console.error("FAIL: unbalanced"); process.exit(1); }

// 2) vm 环境:UCn 是 vendor 的 entry 工厂,给替身以验证 execute 路径
const tools = [
  { serverName: "wind", toolName: "wind-stock", description: "stock quotes", inputSchema: { type: "object", properties: { code: { type: "string" } }, required: ["code"] } },
  { serverName: "wind", toolName: "wind-index", description: "index quotes" },
  { serverName: "ida", toolName: "decompile", description: "decompile function", inputSchema: { type: "object", properties: { addr: { type: "string" } } } },
];
let ucCalls = 0;
const P = { capability: "cap", outputSchema: {}, permission: {}, resultBudget: {}, timeout: {}, cancellation: {}, trace: {}, metadata: {} };
const fake = {
  registry: { get: (n) => (n === "Read" ? P : null), register: () => {} },
  config: { toolAllowlist: undefined, toolDisallowlist: undefined },
  mcpPort: { listTools: async () => tools },
};
const ctx = {
  console,
  UCn: (name, desc, port, isCua, opts) => {
    ucCalls++;
    return { handler: async (args, c) => ({ content: [{ type: "text", text: "ran " + name + " " + JSON.stringify(args) }] }) };
  },
};
vm.createContext(ctx);
vm.runInContext(code + ";globalThis.__entry=__zcodeMcpSearchEntry", ctx);
const entry = ctx.__entry(fake);
console.log("entry name:", entry?.metadata?.name);

// 3) JSON-Schema 校验器
function validate(obj, schema) {
  if (schema.type === "object") {
    if (typeof obj !== "object" || obj === null || Array.isArray(obj)) return "not object";
    for (const r of schema.required ?? []) if (!(r in obj)) return "missing " + r;
    for (const [k, sub] of Object.entries(schema.properties ?? {})) {
      if (k in obj) { const v = validate(obj[k], sub); if (v) return k + ": " + v; }
    }
  } else if (schema.type === "string") { if (typeof obj !== "string") return "not string"; }
  else if (schema.type === "array") {
    if (!Array.isArray(obj)) return "not array";
    for (const it of obj) { const v = validate(it, schema.items ?? {}); if (v) return "item: " + v; }
  }
  return null;
}
const os = entry.outputSchema;

(async () => {
  const cases = {
    "full-catalog": await entry.handler({}, {}),
    "keyword-filter": await entry.handler({ query: "ida" }, {}),
    "no-match": await entry.handler({ query: "zzzz" }, {}),
    "inspect": await entry.handler({ tool: "ida/decompile" }, {}),
    "execute": await entry.handler({ tool: "ida/decompile", args: { addr: "0x1809FABB0" } }, {}),
    "bad-tool-ref": await entry.handler({ tool: "ida/nope" }, {}),
  };
  let ok = true;
  for (const [k, v] of Object.entries(cases)) {
    const err = validate(v, os);
    console.log(`   ${err ? "FAIL" : "OK  "} ${k}: ${(v.summary || "").slice(0, 70)}`);
    if (err) { ok = false; console.log("        ->", err, JSON.stringify(v).slice(0, 200)); }
  }
  // 4) execute 确实走了 UCn
  console.log("UCn invoked for execute:", ucCalls === 1);
  if (ucCalls !== 1) ok = false;
  // 5) 白名单拒绝路径
  fake.config.toolDisallowlist = ["wind__wind-stock"];
  const blocked = await entry.handler({ tool: "wind/wind-stock", args: {} }, {});
  const bOk = /Blocked/.test(blocked.summary);
  console.log("   " + (bOk ? "OK  " : "FAIL") + " disallowlist-block: " + blocked.summary.slice(0, 60));
  if (!bOk) ok = false;
  fake.config.toolDisallowlist = undefined;
  fake.config.toolAllowlist = ["ida__decompile"];
  const allowed = await entry.handler({ tool: "ida/decompile", args: { addr: "1" } }, {});
  const disallowed = await entry.handler({ tool: "wind/wind-stock", args: {} }, {});
  const aOk = !/Blocked/.test(allowed.summary) && /Blocked/.test(disallowed.summary);
  console.log("   " + (aOk ? "OK  " : "FAIL") + " allowlist: ida passes, wind blocked");
  if (!aOk) ok = false;
  // 6) 零服务器
  fake.mcpPort = { listTools: async () => [] };
  const zero = await entry.handler({}, {});
  const zOk = /No MCP servers are connected/.test(zero.summary);
  console.log("   " + (zOk ? "OK  " : "FAIL") + " zero-server: " + zero.summary.slice(0, 50));
  if (!zOk) ok = false;
  process.exit(ok ? 0 : 1);
})();
