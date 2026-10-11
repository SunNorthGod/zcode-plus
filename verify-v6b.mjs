// v6 ToolSearch 回归验证:node verify-v6b.mjs [bundle路径,默认已装 zcode.cjs]
// 覆盖:entry 创建、outputSchema 形状、handler 七种返回形态 schema 校验、
// 加载/卸载分支的 wanted 集状态机与 XFo 调用计数。
import { readFileSync } from "node:fs";
import vm from "node:vm";

const target = process.argv[2] ?? "C:/Program Files/ZCode/resources/glm/zcode.cjs";
const all = readFileSync(target, "utf8");
const L = all.split("\n")[14627];
const iF = L.indexOf("function __zcodeMcpFilter(t){");
const iK = L.indexOf("async function KFo(e){");
const code = L.slice(iF, iK);

const P = { capability: "cap", outputSchema: {}, permission: {}, resultBudget: {}, timeout: {}, cancellation: {}, trace: {}, metadata: {} };
let registered = [];
let xfoCalls = 0;
const fake = {
  registry: { get: (n) => (n === "Read" ? P : null), register: (e) => registered.push(e) },
  config: { mcp: { servers: { "wind": {}, "ida": {} } } },
  mcpPort: { listTools: async () => [
    { serverName: "wind", toolName: "wind-stock", description: "stock quotes" },
    { serverName: "wind", toolName: "wind-index", description: "index quotes" },
    { serverName: "ida", toolName: "decompile", description: "decompile function" },
  ] },
  mcpToolListRevision: 7,
  mcpToolsSignature: "old",
  rootTraceContext: { traceId: "t" },
};

const ctx = {
  console,
  // XFo 替身:验证 it 被调用且 this 绑定正确
  XFo: { call(rt) { xfoCalls++; return Promise.resolve(); } },
};
vm.createContext(ctx);
vm.runInContext(code + ";globalThis.__entry=__zcodeMcpSearchEntry;globalThis.__rt=" + "undefined", ctx);
const entry = ctx.__entry;

// 1) entry 创建 + schema
const e = entry(fake);
console.log("1) entry(fake):", e?.metadata?.name);
const os = e.outputSchema;
console.log("   outputSchema required:", JSON.stringify(os.required), "| tools.items:", JSON.stringify(os.properties?.tools?.items));
console.log("   desc mentions unload:", e.metadata.description.includes("Prefix '-'"));

// 2) 简易 JSON-Schema 校验器(覆盖本场景: type/required/items/additionalProperties 默认允许)
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

(async () => {
  // 3) 四种返回形态过校验
  const cases = {
    "empty-query": await e.handler({}, {}),
    "keyword-load": await e.handler({ query: "wind" }, {}),
    "star-load": await e.handler({ query: "*" }, {}),
    "no-match": await e.handler({ query: "zzzz" }, {}),
    "list-loaded": await e.handler({ query: "-" }, {}),
    "unload-kw": await e.handler({ query: "-wind" }, {}),
    "unload-all": await e.handler({ query: "-*" }, {}),
  };
  let ok = true;
  for (const [k, v] of Object.entries(cases)) {
    const err = validate(v, os);
    console.log(`   ${err ? "FAIL" : "OK  "} ${k}: ${(v.summary || "").slice(0, 60)}`);
    if (err) { ok = false; console.log("        ->", err, JSON.stringify(v).slice(0, 200)); }
  }
  // 4) 状态断言
  console.log("2) wanted after load+unload:", JSON.stringify([...fake.__zcodeMcpWanted]));
  console.log("   XFo called (load+unload):", xfoCalls, "| registered:", registered.length);
  console.log("   desc in entry:", cases["keyword-load"].tools?.length, "tools listed");
  process.exit(ok ? 0 : 1);
})();
