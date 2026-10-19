#!/usr/bin/env node
// ============================================================
// ZCode 本机补丁:Agent 工具调用级 model 参数(动态选型,不写死模型)
// ============================================================
// 目标:resources/glm/zcode.cjs(esbuild 压缩单文件,v3.14.3 锚点验证通过)
// 改动:
//   1. AgentInputSchema 增加 model 可选参数(describe 自说明,不改任何其他提示词)
//   2. agentHandler 按宿主模型目录现查解析(含自定义 provider;失败报错并列出可用清单)
//   3. launch/run/start 三条路径透传 callModel
//   4. resolveSubagentSelection 插入 callSelection 分支,优先级:宿主 override > 调用级 > profile > 继承;
//      调用级在场时抑制父模型继承
// 用法:
//   node apply-model-param-patch.mjs <zcode.cjs>            # 打补丁
//   node apply-model-param-patch.mjs --restore <zcode.cjs>  # 回滚到 zcode.cjs.orig-backup
// 安全:每处替换断言唯一命中,任一失配整体中止不写盘;先写临时文件并 node --check,
//       通过后备份原文再原子换入;若目标被占用会明确报告。
import { readFileSync, writeFileSync, copyFileSync, existsSync, renameSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";

const args = process.argv.slice(2);
const restore = args[0] === "--restore";
const swap = args[0] === "--swap";
const noV2 = !args.includes("--with-v2"); // v2(行显示模型)已弃用:模型后缀挤乱智能体面板标题;默认跳过,须显式 --with-v2 才打入
const target = args.find((a) => !a.startsWith("--"));
if (!target) {
  console.error("usage: node apply-model-param-patch.mjs [--restore] <path-to-zcode.cjs>");
  process.exit(1);
}

if (restore) {
  const backup = target + ".orig-backup";
  if (!existsSync(backup)) { console.error("backup not found: " + backup); process.exit(1); }
  copyFileSync(backup, target);
  console.log("restored from " + backup);
  process.exit(0);
}

// 换入模式(需管理员):备份原文后用补丁临时文件替换目标。
// 必须在打补丁逻辑之前判定——swap 不依赖重新打补丁。
if (process.argv.includes("--swap")) {
  const tmp = join(tmpdir(), "zcode-patched.cjs");
  if (!existsSync(tmp)) { console.error("patched temp not found: " + tmp); process.exit(1); }
  const backup = target + ".orig-backup";
  if (!existsSync(backup)) copyFileSync(target, backup);
  copyFileSync(tmp, target);
  console.log("OK: swapped patched bundle into " + target);
  console.log("backup: " + backup);
  process.exit(0);
}

let src = readFileSync(target, "utf8");
const originalLength = src.length;
const VAR = "__zcodePatch";

/** 断言 pattern 恰好命中一次并替换;失配则报告并整体中止。 */
function applyOnce(name, pattern, makeReplacement) {
  const re = new RegExp(pattern.source, pattern.flags.includes("g") ? pattern.flags : pattern.flags + "g");
  const matches = [...src.matchAll(re)];
  if (matches.length !== 1) {
    console.error(`[ABORT] ${name}: expected exactly 1 match, got ${matches.length} — target untouched`);
    process.exit(1);
  }
  src = src.replace(re, (...rest) => makeReplacement(rest.slice(0, -2)));
}

/** 同 applyOnce,但断言恰好 expected 处命中并全部替换。 */
function applyN(name, pattern, expected, makeReplacement) {
  const re = new RegExp(pattern.source, pattern.flags.includes("g") ? pattern.flags : pattern.flags + "g");
  const matches = [...src.matchAll(re)];
  if (matches.length !== expected) {
    console.error(`[ABORT] ${name}: expected ${expected} matches, got ${matches.length} — target untouched`);
    process.exit(1);
  }
  src = src.replace(re, (...rest) => makeReplacement(rest.slice(0, -2)));
}

// ---------- 结构校验:捕获 handler 作用域绑定名 ----------
// v1(调用级 model 参数)已应用过则整体跳过,只执行 v2(行显示模型)步骤。
const v1Applied = src.includes(VAR + "CallModel");
if (!v1Applied) {
const hb = src.match(/async\(([\w$]+),([\w$]+)\)=>\{let ([\w$]+)=([\w$]+)\.parse\(\1\),[\w$]+=\3\.subagent_type\?\?[\w$]+\.GeneralPurpose/);
if (!hb) { console.error("[ABORT] handler structure not found"); process.exit(1); }
const [, hIn, hCtx, hParsed] = hb;
const he = src.match(new RegExp(`throw ([\\w$]+)\\(([\\w$]+)\\.ConfigurationError,"SubagentPort is not configured for Agent tool"`));
if (!he) { console.error("[ABORT] handler error bindings not found"); process.exit(1); }
const [, hErr, hErrType] = he;
if (src.includes(VAR + "CallModel") || src.includes(VAR + "ResolveModelRef") || src.includes(VAR + "CallSel")) {
  console.error("[ABORT] injected identifier already present — already patched?"); process.exit(1);
}

// ---------- 1. AgentInputSchema:插入 model 参数 ----------
applyOnce(
  "schema.model-param",
  /(subagent_type:([\w$]+)\.string\(\)\.optional\(\)\.describe\("The type of specialized agent to use for this task"\),)/,
  (g) => g[1] +
    `model:${g[2]}.string().optional().describe("Model for the subagents (providerId/modelId, a bare modelId when unambiguous, optional $reasoning suffix). Resolved against this host's live model catalog at call time, including custom providers; an unknown name fails with the available list. Omit to let the agent's profile/settings decide."),`,
);

// ---------- 2. agentHandler:解析 model → callModel,并传入 launch options ----------
{
  const m2 = src.match(new RegExp(
    `"SubagentPort is not configured for Agent tool",\\{context:\\{code:[\\w$]+\\.SUBAGENT_UNAVAILABLE,toolCallId:${hCtx}\\.toolCallId,toolName:"Agent"\\},recoverable:!1\\}\\);let [\\w$]+=\\{sessionId:`,
  ));
  if (!m2) { console.error("[ABORT] handler inject-point not found"); process.exit(1); }

  const RESOLVER = `function ${VAR}ResolveModelRef(txt,es){const t0=txt.trim(),si=t0.indexOf("/"),di=t0.indexOf("$",si+1);let ref=t0,lv;if(di>si&&di<t0.length-1){ref=t0.slice(0,di);lv=t0.slice(di+1)}const eq=(x,y)=>x.trim().toLowerCase()===y.trim().toLowerCase();const p=ref.indexOf("/");let ms;if(p>0){const pid=ref.slice(0,p),mid=ref.slice(p+1);ms=es.filter(mm=>eq(mm.providerId,pid)&&eq(mm.modelId,mid))}else ms=es.filter(mm=>eq(mm.modelId,ref));if(ms.length===0)return{ok:!1,reason:"not_found",message:"No configured model matches \\u0060"+txt+"\\u0060. Available: "+es.filter(mm=>mm.disabledReason===void 0).map(mm=>mm.providerId+"/"+mm.modelId).join(", ")};const en=ms.filter(mm=>mm.disabledReason===void 0);if(en.length===0)return{ok:!1,reason:"disabled",message:"\\u0060"+txt+"\\u0060 matches a model that cannot be used on this host: "+ms.map(mm=>mm.providerId+"/"+mm.modelId+" ("+mm.disabledReason+")").join("; ")};const hit=en.length===1?en[0]:en.find(c=>c.current);if(hit===void 0)return{ok:!1,reason:"ambiguous",message:"\\u0060"+txt+"\\u0060 is configured under more than one provider: "+en.map(mm=>mm.providerId+"/"+mm.modelId).join(", ")+". Pass the full providerId/modelId."};let op;if(lv!==void 0){const vv=hit.reasoningLevels.find(c=>eq(c,lv));if(vv===void 0)return{ok:!1,reason:"reasoning_level_unknown",message:"\\u0060"+lv+"\\u0060 is not a reasoning level of "+hit.providerId+"/"+hit.modelId+". Levels: "+hit.reasoningLevels.join(", ")};op={reasoningLevel:vv}}else if(hit.reasoningLevels.length>0&&hit.defaultReasoningLevel!==void 0)op={reasoningLevel:hit.defaultReasoningLevel};return{ok:!0,selection:{providerId:hit.providerId,modelId:hit.modelId,...(op?{options:op}:{})}}};`;

  const inject =
    `let ${VAR}CallModel;{const mv=${hParsed}.model;if(mv!==void 0){const mc=${hCtx}.modelCatalogPort;` +
    `if(!mc)throw ${hErr}(${hErrType}.ConfigurationError,"modelCatalogPort is not configured for Agent tool; cannot resolve the requested subagent model",{context:{code:"agent_model_unresolved",toolCallId:${hCtx}.toolCallId,toolName:"Agent"},recoverable:!0});` +
    RESOLVER +
    `const rr=${VAR}ResolveModelRef(mv,mc.listModels());` +
    `if(!rr.ok)throw ${hErr}(${hErrType}.ToolExecutionFailed,rr.message,{context:{code:"agent_model_unresolved",reason:rr.reason,toolCallId:${hCtx}.toolCallId,toolName:"Agent"},recoverable:!0});` +
    `${VAR}CallModel={selection:rr.selection}}}`;

  applyOnce(
    "handler.inject-resolution",
    new RegExp(`("SubagentPort is not configured for Agent tool",\\{context:\\{code:[\\w$]+\\.SUBAGENT_UNAVAILABLE,toolCallId:${hCtx}\\.toolCallId,toolName:"Agent"\\},recoverable:!1\\}\\);)(let [\\w$]+=\\{sessionId:)`),
    (g) => g[1] + inject + g[2],
  );

  applyOnce(
    "handler.launch-options",
    /(\.\.\.([\w$]+)\.subagentModelOverride\?\{modelOverride:\2\.subagentModelOverride\}:\{\})(?=\}\))/,
    (g) => g[1] + `,callModel:${VAR}CallModel`,
  );
}

// ---------- 3. runner launch():后台分支透传 callModel 到 start ----------
applyOnce(
  "runner.launch.start-options",
  // 3.16.1 起官方在 model spread 后追加 modelOverride spread,锚点改看逗号续 spread
  /(return [\w$]+\.start\([\w$]+,\{signal:[\w$]+\?\.signal,\.\.\.([\w$]+)\?\.model\?\{model:\2\.model\}:\{\})(?=,\.\.\.)/,
  (g) => g[1] + `,callModel:${g[2]}?.callModel`,
);

// ---------- 4. runner run():runAgentToCompletion 子集透传 ----------
applyOnce(
  "runner.run.subset",
  // 3.16.1 起三处 runner 路径都有 modelOverride spread,用后续参数区分 run(带 reportActivity)
  /(\.\.\.([\w$]+)\?\.modelOverride\?\{modelOverride:\2\.modelOverride\}:\{\})(?=\},\{reportActivity:)/,
  (g) => g[1] + `,callModel:${g[2]}?.callModel`,
);

// ---------- 5. runner start():runBackgroundAgent 子集透传 ----------
applyOnce(
  "runner.start.subset",
  // 3.16.1 起该处 options 带官方 model/modelOverride 透传,锚点挂 modelOverride spread(后随 onSessionReady 参数区分)
  /(\.\.\.([\w$]+)\?\.modelOverride\?\{modelOverride:\2\.modelOverride\}:\{\})(?=\},\{onSessionReady:)/,
  (g) => g[1] + `,callModel:${g[2]}?.callModel`,
);

// ---------- 6. runExploreAgent:callSelection 进解析器 + 抑制继承 ----------
applyOnce(
  "explore.overrideSelection",
  /(overrideSelection:([\w$]+)\?\.modelOverride\?\.selection,)(resolveSelection:)/,
  (g) => g[1] + `callSelection:${g[2]}?.callModel?.selection,` + g[3],
);
applyOnce(
  "explore.inherit-suppress",
  /(=([\w$]+)\?\.modelOverride,)([\w$]+)=!([\w$]+)&&!([\w$]+)\?([\w$]+)\?\.model:void 0/,
  (g) => {
    if (g[6] !== g[2]) { console.error("[ABORT] explore.inherit-suppress: var mismatch"); process.exit(1); }
    return g[1] + g[3] + "=!" + g[4] + "&&!" + g[2] + "?.callModel&&!" + g[5] + "?" + g[6] + "?.model:void 0";
  },
);

// ---------- 7. resolveSubagentSelection:callSelection 分支(宿主 override 之下、profile 之上) ----------
{
  // 函数头注入 const __zcodePatchCallSel = <param>.callSelection;
  applyOnce(
    "selection.fn-head",
    /function ([\w$]+)\(([\w$]+)\)\{let ([\w$]+)=\2\.profileSelection,/,
    (g) => `function ${g[1]}(${g[2]}){const ${VAR}CallSel=${g[2]}.callSelection;let ${g[3]}=${g[2]}.profileSelection,`,
  );
  // 优先级链:override ? A : [插入 callSel ? B] : profile ? C : parent
  applyOnce(
    "selection.callSelection-branch",
    /=[\w$]+\.overrideSelection\?\{effectiveSelection:[\w$]+\.overrideSelection\}:([\w$]+)\?([\w$]+\.resolveSelection)\?([\w$]+\.resolveSelection)\(([\w$]+)\(([\w$]+)\)\):\{effectiveSelection:\1\}/,
    (g) => {
      const [, profileVar, cond, call, cloneFn, argVar] = g;
      if (argVar !== profileVar) { console.error("[ABORT] selection.callSelection-branch: var mismatch"); process.exit(1); }
      return (
        `=__zcodePatchCallSel?${cond}?${call}(${cloneFn}(__zcodePatchCallSel)):{effectiveSelection:__zcodePatchCallSel}` +
        `:${profileVar}?${cond}?${call}(${cloneFn}(${profileVar})):{effectiveSelection:${profileVar}}`
      );
    },
  );
  // 错误信息里的 requested 链带上 callSelection
  applyOnce(
    "selection.error-chain",
    /=([\w$]+)\.overrideSelection\?\?([\w$]+\?\?[\w$]+\.parentSelection)/,
    (g) => `=${g[1]}.overrideSelection??${VAR}CallSel??${g[2]}`,
  );
}
} // end if (!v1Applied)

// ============================================================
// v2:子代理行显示实际模型(始终显示,含推理档位)
// ============================================================
// 原理:SubagentSpawned 事件与完成镜像事件的 description 追加 " · provider/model$level";
// UI 行(summaryText)、侧栏标题、后台任务标题都透传 description,零 UI 改动。
// v2 自身幂等:替换后锚点不再匹配,重复运行自然跳过。

// 生成 `providerId/modelId$level` 的模板字面量文本(access 为作用域内的对象访问链)
function fmtSel(access) {
  return '`${' + access + '.providerId}/${' + access + '.modelId}${' + access +
    '.options?.reasoningLevel?"$"+' + access + '.options.reasoningLevel:""}`';
}

// 优先级链(runner 作用域:f=options,g=profile):宿主 override > 调用级 > profile > 继承父
const chainRunner =
  "(f?.modelOverride?.selection?" + fmtSel("f.modelOverride.selection") +
  ":f?.callModel?.selection?" + fmtSel("f.callModel.selection") +
  ":g.modelSelection?" + fmtSel("g.modelSelection") +
  ":f?.model?" + fmtSel("f.model") +
  ":void 0)";

// v2 已应用检测:fmtSel 生成的三元链是本补丁独有的代码形态。--no-v2 时不打入。
const v2Applied = noV2 || src.includes('.options?.reasoningLevel?"$"+');

// runExploreAgent 作用域:a = resolveSubagentSelection 的解析结果(必非空,覆盖全优先级)
const chainExplore = "(" + fmtSel("a") + ")";

if (!v2Applied) {
// --- v2.1 两处 SubagentSpawned 事件的 description 追加模型后缀 ---
applyN(
  "v2.spawn-emission",
  /description:([\w$]+)\.description,prompt:([\w$]+)\.prompt,parentToolCallId:\2\.parentToolCallId,status:"running",allowedTools:/,
  2,
  (g) => {
    const req = g[1];
    return (
      `description:${req}.description+(${chainRunner}?" \\u00b7 "+${chainRunner}:""),` +
      `prompt:${req}.prompt,parentToolCallId:${req}.parentToolCallId,status:"running",allowedTools:`
    );
  },
);

// --- v2.2 完成镜像事件的 description(runExploreAgent eventSink)追加模型后缀 ---
// 注意:同类描述字段还出现在 deriveChildClientPorts 的路由身份里,那里不能动;
// 用 background 字段精确定位事件镜像这一处。
applyN(
  "v2.mirror-description",
  /(agentType:([\w$]+)\.agentType,background:\2\.background,childSessionId:\2\.sessionId,)description:\2\.description,(parentSessionId:this\.sessionId)/,
  1,
  (g) => g[1] + `description:${g[2]}.description+(${chainExplore}?" \\u00b7 "+${chainExplore}:""),` + g[3],
);
} else {
  console.log("v2 deprecated by default — skipping row-display (pass --with-v2 to force)");
}

// ============================================================
// v3:claude 系模型跳过 todo_reminder 注入
// ============================================================
// 背景:turn-loop 每 10 轮未写 TodoWrite 即向对话尾部注入一条 system-reminder
// 附件(以 user 轮次形态出现)。GLM 系对此无感;claude 的先验把「对话尾部新增
// user 轮」读作用户交互,上下文失锚时会误读为用户催促信号导致行为跑偏。
// 改动:注入条件追加「当前模型 modelId 含 claude 时跳过」。跳过仅省略提醒,
// 不影响 TodoWrite 工具本身;e.model 异常时表达式退化为不跳过(保持原行为)。
const v3Applied = src.includes("!/claude/i.test(");
if (!v3Applied) {
  applyOnce(
    "v3.todo-reminder-skip",
    /([\w$]+)\.some\(([\w$]+)=>\2\.name==="TodoWrite"\)&&([\w$]+)\(([\w$]+)\.turnRequestState\.entries\)/,
    (g) => g[0] + `&&!/claude/i.test(${g[4]}.model&&${g[4]}.model.modelId)`,
  );
} else {
  console.log("v3 already applied — skipping todo-reminder-skip");
}

// ============================================================
// v4:MCP 开关实时生效(接通官方预留的 refreshMcpToolsIfChanged)
// ============================================================
// 商业版已实现完整的刷新函数(keepNames: refreshMcpToolsIfChanged):
// 按 mcpPort.toolListRevision() 版本号检测工具清单变化,变化时注销旧
// mcp 工具、按当前池重注册并失效工具缓存——但没有任何调用方,是死代码。
// 两个坑:①版本号只在服务器推送 tools/list_changed 通知时自增,开关引起
// 的连接/断开不动它(新 adapter 计数器为 0,池级求和不变形);②函数从未
// 被接线。补丁 = 在 initializeMcp 的已注册闸门接上刷新调用,并维护
// 「服务器名单签名」:名单变化时强制把版本号置空,逼刷新走重注册。
// 未变化的回合只多一次进程内 status() 读表,纳秒到微秒级。
const v4Applied = src.includes("__zcodeMcpSync");
if (!v4Applied) {
  const mInit = src.match(/\(([\w$]+),"initializeMcp"\)/);
  const mRef = src.match(/\(([\w$]+),"refreshMcpToolsIfChanged"\)/);
  const head = mInit && mRef
    ? src.match(new RegExp(`async function ${mInit[1]}\\(([\\w$]+)\\)\\{if\\(this\\.mcpToolsRegistered\\)return;`))
    : null;
  if (!mInit || !mRef || !head) {
    console.error("[WARN] v4: anchors missing/changed (initializeMcp / refreshMcpToolsIfChanged) — skipping mcp-live patch");
  } else {
    const kfo = mInit[1], xfo = mRef[1], trace = head[1];
    const kfoStart = src.indexOf(`async function ${kfo}(${trace}){`);
    const regionEnd = src.indexOf('"mcp.tools.registered"', kfoStart);
    const region = src.slice(kfoStart, regionEnd);
    const portVar = (region.match(/([\w$]+)=this\.mcpPort/) || [])[1];
    const snapVar = (region.match(/let ([\w$]+)=await /) || [])[1];
    const gateOld = "if(this.mcpToolsRegistered)return;";
    const gateCount = src.split(gateOld).length - 1;
    const sigAnchor = portVar
      ? `this.mcpToolListRevision=${portVar}.toolListRevision?.(),this.logger?.info("MCP tools registered"`
      : null;
    if (!portVar || !snapVar || gateCount !== 1 || !sigAnchor || !src.includes(sigAnchor)) {
      console.error(`[WARN] v4: gate x${gateCount} / port=${portVar} / snap=${snapVar} / sig=${!!sigAnchor && src.includes(sigAnchor)} — skipping mcp-live patch`);
    } else {
      const HELPER =
        `async function __zcodeMcpSync(${trace}){let p=this.mcpPort;` +
        `if(p)try{let s=await p.status(),g=Object.keys(s).sort().join(",");` +
        `if(g!==this.__zcodeMcpSrvSig){this.__zcodeMcpSrvSig=g,this.mcpToolListRevision=void 0}}catch(i){}` +
        `return ${xfo}.call(this,${trace}).catch(()=>{})}`;
      src = src.replace(`async function ${kfo}(${trace}){`, `async function ${kfo}(${trace}){` + HELPER);
      src = src.replace(gateOld, `if(this.mcpToolsRegistered)return __zcodeMcpSync.call(this,${trace});`);
      // KFo catch 强化:①失败不锁死 mcpToolsRegistered(原版一次失败永久禁注册,
      // v4/v6 下表现为整会话无 MCP 无 McpSearch);②error 带堆栈落日志便于定位
      const catchRe = new RegExp(`catch\\(([\\w$]+)\\)\\{this\\.mcpToolsRegistered=!0,this\\.logger\\?\\.warn\\("MCP initialization failed",\\{\\.\\.\\.Sr\\(${trace}\\),error:\\1 instanceof Error\\?\\1\\.message:String\\(\\1\\),event:"mcp\\.initialization\\.failed",module:"core\\.runtime",status:"failed"\\}\\)\\}`);
      if (!catchRe.test(src)) {
        console.error("[WARN] v4: KFo catch anchor missing — init-failure lock not removed");
      } else {
        src = src.replace(catchRe, `catch($1){this.logger?.warn("MCP initialization failed",{...Sr(${trace}),error:$1 instanceof Error?$1.message:String($1),stack:$1 instanceof Error?String($1.stack):void 0,event:"mcp.initialization.failed",module:"core.runtime",status:"failed"})}`);
      }
      // 首次注册路径记录服务器名单签名(避免会话第二轮就触发一次无谓重注册)
      src = src.replace(
        sigAnchor,
        `this.mcpToolListRevision=${portVar}.toolListRevision?.(),` +
        `this.__zcodeMcpSrvSig=Object.keys(${snapVar}.statuses??{}).sort().join(","),` +
        `this.logger?.info("MCP tools registered"`,
      );
      console.log("v4 applied: mcp live-toggle wired via refreshMcpToolsIfChanged");
    }
  }
}

// ============================================================
// v7:MCP 无状态网关(McpSearch——skill 式两段披露,无装卸)
// 改名缘由(2026-10-19,3.16.1):官方自带同名 ToolSearch 功能(toolSearchMode,默认 off),
// 且 getTools 过滤器在 mode=off 时按名剥除 "ToolSearch"/"DeferredToolCall"
// (原意是功能没开就藏自家工具),撞名的本网关被一并静默隐藏。McpSearch 不踩任何
// 官方按名过滤器,官方模式无论开关都互不干扰。
// ============================================================
// 会话出生不注册任何 mcp__ 工具 Schema(上下文省掉大头),mcp__ 工具
// 永远不注册。McpSearch 是无状态网关,三个只读动词 + 一个透传动词:
//   {}                    → 全目录(一行一工具,超预算降级服务器分组)
//   {query:"ida"}         → 关键词过滤目录(OR 计分,搜索面仅 server/tool 名)
//   {tool:"ida/decompile"} → 返回该工具的完整 inputSchema 与描述
//   {tool:"...",args:{}}  → 临场构造 UCn entry(不注册)直接调其 handler,
//                           权限/审批/预算/超时/trace/结果格式化全部复用 vendor。
// 工具面从出生到死亡恒定:零状态、零装卸、零重注册,前缀缓存不被 MCP 打断。
// 权限语义:$bt 的白名单(allowedTools/disallowedTools)在网关内等价复刻
// (toolFound 且被禁 → 报错),审批由 UCn.permission(needsApproval=true)
// 在 executor 层照常触发 — 网关不绕过任何 vendor 权限层。
const v7Applied = src.includes("__zcodeMcpSearchEntry");
if (!v7Applied) {
  const mInit = src.match(/\(([\w$]+),"initializeMcp"\)/);
  // v4 后形态:KFo 体开头插入了 __zcodeMcpSync 定义,gate 变为 return __zcodeMcpSync.call(this,e);
  const headOk = mInit && src.includes(`async function ${mInit[1]}(e){async function __zcodeMcpSync`) &&
    src.includes(`if(this.mcpToolsRegistered)return __zcodeMcpSync.call(this,${mInit[1] === "KFo" ? "e" : "e"});`);
  if (!headOk) {
    console.error("[WARN] v7: anchors missing/changed (v4 must be applied first) — skipping gateway patch");
  } else {
      const regK = src.match(/([\w$]+)=([\w$]+)\(this\.registry,([\w$]+),([\w$]+)\.tools,\{allowedTools:this\.config\.toolAllowlist/);
      const regX = src.match(/([\w$]+)=([\w$]+)\(this\.registry,([\w$]+),([\w$]+),\{allowedTools:this\.config\.toolAllowlist/);
      const sigRec = src.match(/(this\.__zcodeMcpSrvSig=Object\.keys\(([\w$]+)\.statuses\?\?\{\}\)\.sort\(\)\.join\(.{1,6}?\),)/);
      // vendor 名捕获:注册名构造(aD=toMcpToolName)、规范化(f3e=normalizeToolNameAlias)、
      // CUA 特例名(kOa=toRegisteredMcpToolName)
      const mA = src.match(/\(([\w$]+),"toMcpToolName"\)/);
      const mN = src.match(/\(([\w$]+),"normalizeToolNameAlias"\)/);
      const mK = src.match(/\(([\w$]+),"toRegisteredMcpToolName"\)/);
      const mPie = src.match(/\(([\w$]+),"createMcpToolDisplay"\)/);
      const mSgt = src.match(/r\(([\w$]+),"createToolResultDisplay"\)/);
      if (!regK || !regX || !sigRec || !mA || !mN || !mK || !mPie || !mSgt) {
        console.error("[WARN] v7: register-call anchors not usable — skipping gateway patch");
      } else {
        const ad = mA[1], f3 = mN[1], ko = mK[1], pie = mPie[1], sgt = mSgt[1];
      const FACTORY =
        `function __zcodeMcpSearchEntry(rt){let P=rt.registry.get("Read")||rt.registry.get("Grep")||rt.registry.get("TodoWrite");if(!P)return null;` +
        `return {capability:P.capability,` +
        `inputSchema:{type:"object",properties:{query:{type:"string",description:"Optional. Filter the catalog: keywords against server/tool names only (e.g. 'ida', 'decompile'). Omit to see the full catalog."},tool:{type:"string",description:"Optional. 'serverName/toolName' to inspect (returns its full parameter schema and description) or to execute. Use the exact names shown in the catalog."},args:{type:"object",description:"Optional. Arguments object for the tool being executed. Provide together with 'tool'. Get the expected parameters from an inspect call first.",additionalProperties:true}},required:[]},` +
        `outputSchema:{$schema:"http://json-schema.org/draft-07/schema#",type:"object",properties:{summary:{type:"string"},tools:{type:"array",items:{type:"string"}}},required:["summary"]},` +
        `permission:{permission:"mcp",reason:"MCP gateway McpSearch executes tools on external MCP servers",riskLevel:"medium",sideEffectScope:"network",needsApproval:!0,patternSources:["toolName","input","network"],denyPriority:"beforeAsk"},` +
        `resultBudget:{maxInlineBytes:1e5,maxModelBytes:5e4,strategy:"truncate",preview:{direction:"head"}},timeout:P.timeout,cancellation:P.cancellation,trace:P.trace,` +
        `metadata:{...P.metadata,name:"McpSearch",readOnly:!1,destructive:!1,concurrentSafe:!0,needsApproval:!1,sideEffectScope:"network",` +
        `description:"Gateway to MCP tools (tools from external MCP servers ONLY). Core built-in tools (Read, Grep, Glob, Bash, Edit, Write, TodoWrite, Agent, ...) are ALWAYS directly available - never use this gateway for them. MCP tools are NOT listed in your tools. FIRST call without arguments to see the full catalog (one line per MCP tool). Then: McpSearch {tool:'server/tool'} inspects that tool (returns its parameter schema), and McpSearch {tool:'server/tool', args:{...}} executes it. All three are read-only catalog/inspect, execute runs the real tool. Nothing is loaded or unloaded - the gateway is stateless, your tool list never changes."},` +
        `handler:async(i,c)=>{let port=rt.mcpPort;if(!port)return{summary:"MCP is not available in this session."};` +
        `let all;try{all=await port.listTools()}catch(err){return{summary:"MCP tool list unavailable: "+(err&&err.message||err)}}` +
        `if(!all.length)return{summary:"No MCP servers are connected in this session."};` +
        `let q=String((i&&i.query)||"").trim(),toolSpec=String((i&&i.tool)||"").trim(),args=(i&&i.args&&typeof i.args==="object")?i.args:void 0;` +
        // inspect / execute 分支:toolSpec 形如 server/tool
        `if(toolSpec){let slash=toolSpec.indexOf("/");let sName=slash>0?toolSpec.slice(0,slash):toolSpec,tName=slash>0?toolSpec.slice(slash+1):"";` +
        `if(!tName)return{summary:"Bad tool reference '"+toolSpec+"'. Use 'serverName/toolName' exactly as shown in the catalog."};` +
        `let t=all.find(x=>x.serverName===sName&&x.toolName===tName);` +
        `if(!t){let near=all.filter(x=>x.serverName===sName||x.toolName===tName).map(x=>x.serverName+"/"+x.toolName).slice(0,5);return{summary:"No such MCP tool: '"+toolSpec+"'."+(near.length?" Closest: "+near.join(", ")+"":" Call McpSearch with no arguments to see the full catalog.")}}` +
        // 白名单复刻(与 $bt 同源语义,逐字对齐 vendor 形态):
        //   注册名 = aD(descriptor) = "mcp__"+N8(server)+"__"+N8(tool)(CUA 特例走 kOa)
        //   allowed/disallowed 集条目经 f3e 规范化(jDa 去参数后 f3e,f3e 只做别名归一)
        //   handler 是箭头函数无 this 绑定,配置一律走闭包里的 rt
        `let alw=rt.config&&rt.config.toolAllowlist?new Set(rt.config.toolAllowlist.map(${f3})):void 0,dis=rt.config&&rt.config.toolDisallowlist?new Set(rt.config.toolDisallowlist.map(${f3})):void 0;let rn=${ko}(t,!1);` +
        `if(dis&&dis.has(rn))return{summary:"Blocked: "+rn+" is disallowed in this session."};if(alw&&!alw.has(rn))return{summary:"Blocked: "+rn+" is not in this session's allowed tools."};` +
        // inspect:返回参数表
        `if(!args){let sch=t.inputSchema&&typeof t.inputSchema==="object"?t.inputSchema:{type:"object",properties:{},additionalProperties:!0};` +
        `return{summary:"[inspect "+toolSpec+"] params & description:",tools:[String(t.description||"(no description)"),"arguments schema: "+JSON.stringify(sch)]}}` +
        // execute:临场构造 UCn entry(不注册),复用其 handler(权限/预算/trace/结果格式化)
        // UCn handler 返回 MCP 原始形状 {content:[blocks]},网关转成自己的 {summary,tools}
        `let entry;try{entry=UCn(rn,t,port,!1,{pluginId:void 0})}catch(err){return{summary:"Gateway cannot build tool entry for "+toolSpec+": "+(err&&err.message||err)}}` +
        `let res;try{res=await entry.handler(args,c)}catch(err){return{summary:"MCP tool '"+toolSpec+"' failed: "+(err&&err.message||err)}}` +
        `let txt="";if(res&&Array.isArray(res.content)){txt=res.content.map(b=>b&&typeof b==="object"&&typeof b.text==="string"?b.text:JSON.stringify(b)).join("\\n")}else if(res!==void 0&&res!==null)txt=typeof res==="string"?res:JSON.stringify(res);` +
        `if(txt.length>48000)txt=txt.slice(0,48000)+"\\n[truncated by gateway]";` +
        `return{summary:"["+toolSpec+"] returned:",tools:txt?[txt]:[],mcpDisplay:{serverName:sName,toolName:tName}}}` +
        // 目录分支:空=全量,query=关键词过滤(搜索面仅 server/tool 名,断子串劫持)
        `let byS={};for(const t of all){(byS[t.serverName]=byS[t.serverName]||[]).push(t.toolName)}` +
        `let picks;` +
        `if(!q)picks=all;else{let toks=q.toLowerCase().split(/\\s+/).filter(Boolean);picks=all.map(t=>{let hay=(t.serverName+" "+t.toolName).toLowerCase(),sc=0,miss=0;for(const k of toks){let n=hay.split(k).length-1;if(n===0)miss++;sc+=n}return{t,sc,miss}}).filter(x=>x.sc>0).sort((a,b)=>a.miss-b.miss||b.sc-a.sc).map(x=>x.t)}` +
        `if(picks.length===0)return{summary:"No MCP tool matches '"+q+"'. Call McpSearch with no arguments to see the full catalog, then retry with a server name or tool name from it."};` +
        `let lines=picks.map(t=>"- "+t.serverName+"/"+t.toolName+": "+String(t.description||"").replace(/\\s+/g," ").slice(0,80)).join("\\n");` +
        `if(lines.length>24000){lines=Object.entries(byS).filter(e2=>picks.some(t=>t.serverName===e2[0])).map(e2=>"- "+e2[0]+" ("+e2[1].length+" tools): "+e2[1].join(", ")).join("\\n");if(lines.length>24000)lines=Object.entries(byS).filter(e2=>picks.some(t=>t.serverName===e2[0])).map(e2=>"- "+e2[0]+" ("+e2[1].length+" tools)").join("\\n")}` +
        `return{summary:"MCP tool catalog ("+picks.length+" of "+all.length+" tools, "+Object.keys(byS).length+" servers) - inspect with McpSearch {tool:'server/tool'}, execute with McpSearch {tool:'server/tool', args:{...}}:",tools:lines.split("\\n")}}}}`;
      // 1) 注入工厂(KFo 之前,模块作用域,UCn/$bt 均可见)
      src = src.replace(`async function ${mInit[1]}(e){async function __zcodeMcpSync`,
        FACTORY + `async function ${mInit[1]}(e){async function __zcodeMcpSync`);
      // 2) 两处注册点一刀切隐藏(mcp__ 工具永不注册)
      src = src.replace(`${regK[2]}(this.registry,${regK[3]},${regK[4]}.tools,{allowedTools:this.config.toolAllowlist`,
        `${regK[2]}(this.registry,${regK[3]},[],{allowedTools:this.config.toolAllowlist`);
      src = src.replace(`${regX[2]}(this.registry,${regX[3]},${regX[4]},{allowedTools:this.config.toolAllowlist`,
        `${regX[2]}(this.registry,${regX[3]},[],{allowedTools:this.config.toolAllowlist`);
      // 3) 首次注册路径:挂网关本体(注册列表为空,只挂 McpSearch)
      src = src.replace(sigRec[1] + `this.logger?.info("MCP tools registered"`,
        sigRec[1] + `(this.__zcodeMcpSearchEntryObj=__zcodeMcpSearchEntry(this))&&this.registry.register(this.__zcodeMcpSearchEntryObj),this.invalidateToolCache(),this.logger?.info("MCP tools registered"`);
      // 4) v4 助手头部兜底创建(注册路径未走到时)
      src = src.replace(/async function __zcodeMcpSync\((\w)\)\{/,
        `async function __zcodeMcpSync($1){if(!this.__zcodeMcpSearchEntryObj){try{let se=__zcodeMcpSearchEntry(this);se&&this.registry.register(se),this.invalidateToolCache()}catch(i){}}`);
      // 5) UI 行标题:createToolResultDisplay 头部插 McpSearch 分支 —
      //    网关 execute 返回值带 mcpDisplay{serverName,toolName},转成 vendor 的
      //    mcp_tool display 形态(Pie 同款),UI 行标题即显示实际执行的 server/tool
      const sgtHeadOld = `function ${sgt}(e,t,n){if(e==="Bash")`;
      const sgtHeadNew = `function ${sgt}(e,t,n){if(e==="McpSearch"&&t&&typeof t.mcpDisplay=="object"){let d=${pie}({...t.mcpDisplay,description:t.summary},t);if(d)return d}if(e==="Bash")`;
      if (src.split(sgtHeadOld).length - 1 !== 1) {
        console.error("[WARN] v7: createToolResultDisplay anchor mismatch — UI row title will stay 'McpSearch'");
      } else {
        src = src.replace(sgtHeadOld, sgtHeadNew);
      }
      console.log("v7 applied: McpSearch stateless MCP gateway wired (catalog/inspect/execute, zero load/unload)");
    }
  }
}

// ============================================================
// v8:SendMessage 唤醒终态子代理时回填调用级模型
// ============================================================
// 背景:调用级 model 只活在 spawn 那一发的 launch options;任务快照
// (createRuntimeTaskSnapshot)不持久化模型,resumeTerminalAgentInBackground
// 重建的 resumeRequest 不带任何模型字段——SendMessage 唤醒终态子代理后,
// 子代理按父会话常驻选择重建模型,v1 的调用级指定失效。
// 做法:selection 挂在请求对象上(__zCallSel),随快照在进程内持久;
// resume 时把旧任务的选择回填进 runBackgroundAgent 的 run-opts.callModel,
// 复用 v1 已验证的解析链(callSelection 优先级:宿主 override > 调用级 > profile)。
// 边界:跨重启的唤醒不在本期(快照是进程内对象;metadata 重建路径在别的模块)。
if (src.includes("__zCallSel")) {
  console.log("v8 already applied — skipping model-persistence-on-resume");
} else if (!v1Applied && !src.includes(`${VAR}CallModel`)) {
  console.error("[ABORT] v8 requires v1 (callModel) section");
  process.exit(1);
} else {
  // 8.1 快照构建体带上 __zCallSel:优先输入层(resume 续链用),退回请求对象
  applyOnce(
    "v8.snapshot-builder",
    /(turnId:e\.request\.turnId\}\}function )/,
    (g) => `__zCallSel:e.__zCallSel??e.request.__zCallSel,${g[1]}`,
  );

  // 8.2 spawn 请求对象携带 selection(handler 侧;launch→run/start 不剥未知键)
  applyOnce(
    "v8.handler-request-stash",
    new RegExp(`(${VAR}CallModel=\\{selection:rr\\.selection\\}\\}\\};?let ([\\w$]+)=\\{sessionId:)`),
    (g) => g[1].replace(`let ${g[2]}={sessionId:`, `let ${g[2]}={__zCallSel:${VAR}CallModel?.selection,sessionId:`),
  );

  // 8.3 resume 重注册快照时继承旧任务的选择(唤醒→再终态→再唤醒不断链)
  {
    // 快照构建体 keepName 每版改名(ECn→MPn),经 r(X,"createRuntimeTaskSnapshot") 动态捕获
    const snapFn = (src.match(/\(([\w$]+),"createRuntimeTaskSnapshot"\)/) || [])[1];
    if (!snapFn) { console.error("[ABORT] v8: createRuntimeTaskSnapshot keepName not found"); process.exit(1); }
    const re8 = new RegExp(`new Date\\(([\\w$]+)\\.startedAt\\),([\\w$]+)=([\\w$]+);([\\w$]+)\\.register\\(${snapFn}\\(\\{isBackgrounded:!0,lifecycle:([\\w$]+),request:([\\w$]+),startedAt:([\\w$]+),status:"running"\\}\\)\\)`, "g");
    const m8 = [...src.matchAll(re8)];
    if (m8.length !== 1) {
      console.error(`[ABORT] v8.resume-snapshot: expected 1 match, got ${m8.length}`);
      process.exit(1);
    }
    const taskVar = m8[0][3];
    src = src.replace(
      m8[0][0],
      m8[0][0].replace(`status:"running"})`, `status:"running",__zCallSel:${taskVar}.__zCallSel})`),
    );

    // 8.4 resume 调用把旧任务的选择回填进 run-opts.callModel
    //     (镜像 v1 在 start 路径已验证的透传:xRo 的 run-opts.callModel
    //      会流进 runExploreAgent 的解析器,callSelection 参与优先级链)
    // 3.16.1 起 resume 调用带官方 model/modelOverride 透传(u 为空时是 no-op,与 callModel 回填不冲突)
    const re9 = /([\w$]+\([\w$]+,[\w$]+,[\w$]+,[\w$]+,)\{signal:([\w$]+)\.signal,model:[\w$]+\?\.model,modelOverride:[\w$]+\?\.modelOverride\},\{resumeFromStore:!0,onSessionReady:/g;
    const m9 = [...src.matchAll(re9)];
    if (m9.length !== 1) {
      console.error(`[ABORT] v8.resume-invoke: expected 1 match, got ${m9.length}`);
      process.exit(1);
    }
    src = src.replace(
      m9[0][0],
      `${m9[0][1]}{signal:${m9[0][2]}.signal,...(${taskVar}.__zCallSel?{callModel:{selection:${taskVar}.__zCallSel}}:{})},{resumeFromStore:!0,onSessionReady:`,
    );
  }
  console.log("v8 applied: call-level model persists across SendMessage resume (in-process)");
}

// ============================================================
// v9:流中失败恢复判定兜底(providerCode 纳入 + 中转繁忙文案模式)
// ============================================================
// 背景:上游(尤其中转)在流中返回自定义限流文案时,错误被分类为
// retryable=false + reason=unknown;isRetryableStreamRecoveryFailure(u4a)
// 只查 code/reason/name/message,providerCode 里的 model_rate_limited 不参与
// 判定 → adapter 不重试、core 流中恢复(10 次预算)也判非瞬态 → 一发死。
// 实证(7 天 model_usage):138 条零重试暴毙(全部 fin=null):「模型服务暂时
// 繁忙」死 20、网络断开死 61、服务暂时不可用死 2 等;敏感内容/账号风控类
// 终态属应死,不在此列。
// 做法:①瞬态码检查源加入 providerCode(瞬态码集合含 model_rate_limited,命中即瞬态);
// ②消息模式补中转繁忙类文案与自家流中网络断开文案。配额/敏感内容/风控类
// 文案不匹配,保持终态;恢复预算仍受 STREAM_RECOVERY_MAX_RETRIES=10 封顶。
// 3.16.1 注:官方新增 g8e 繁忙码恢复(业务码 3008/3009/3010,仅官方渠道集),
// 与本补丁互补——中转的自定义文案/字符串 providerCode 只有这里接得住。
// 名称全部动态捕获(每版改名:LS→US、s4a→H4a、p4a→X4a);幂等标记用注入的中文文案。
if (src.includes("暂时繁忙")) {
  console.log("v9 already applied — skipping stream-recovery transient fallback");
} else {
  applyOnce(
    "v9.provider-code-source",
    /let ([\w$]+)=([\w$]+)\(t\.code\)\?\?\2\(n\?\.code\);if\(\1&&([\w$]+)\.has\(\1\)\)return!0;/,
    (g) => `let ${g[1]}=${g[2]}(t.code)??${g[2]}(n?.code)??${g[2]}(t.providerCode)??${g[2]}(n?.providerCode);if(${g[1]}&&${g[3]}.has(${g[1]}))return!0;`,
  );
  applyOnce(
    "v9.message-pattern",
    /let ([\w$]+)=([\w$]+)\(t\.message\);if\(\1&&([\w$]+)\(\1\)\)return!0/,
    (g) => g[0] + `;if(${g[1]}&&/暂时繁忙|稍后重试|服务繁忙|服务器忙|暂时不可用|没有可用节点|network connection failed|rate.?limit|too many requests|overloaded/i.test(${g[1]}))return!0`,
  );
  console.log("v9 applied: stream-recovery transient fallback (providerCode + relay busy patterns)");
}

// ---------- 校验与落盘 ----------
if (src.length === originalLength) {
  console.log("already up to date — nothing to change");
  process.exit(0);
}
if (v1Applied === false && !src.includes(`${VAR}ResolveModelRef`)) { console.error("[ABORT] resolver missing"); process.exit(1); }

const dir = dirname(target);

let tmp;
try {
  tmp = join(dir, "zcode-patched.tmp.cjs");
  writeFileSync(tmp, src);
} catch {
  // Program Files 目录普通权限不可写:补丁结果放到用户临时目录,换入走 --swap(提权)。
  tmp = join(tmpdir(), "zcode-patched.cjs");
  writeFileSync(tmp, src);
  console.log("[i] target dir not writable; patched temp written to " + tmp);
}

try {
  execFileSync(process.execPath, ["--check", tmp], { stdio: "inherit" });
} catch {
  console.error("[ABORT] patched file failed node --check; target untouched. temp kept: " + tmp);
  process.exit(1);
}

console.log("patched temp validated: " + tmp);
if (tmp !== join(dir, "zcode-patched.tmp.cjs")) {
  console.log("next (elevated): node apply-model-param-patch.mjs --swap " + target);
  console.log("rollback (elevated): copy " + target + ".orig-backup over " + target);
} else {
  const backup = target + ".orig-backup";
  if (!existsSync(backup)) copyFileSync(target, backup);
  try {
    unlinkSync(target);
    renameSync(tmp, target);
  } catch (err) {
    console.error("[LOCKED] cannot replace target: " + err.message);
    process.exit(1);
  }
  console.log("OK: patched " + target);
  console.log("backup: " + backup);
  console.log("rollback: node apply-model-param-patch.mjs --restore " + target);
}
