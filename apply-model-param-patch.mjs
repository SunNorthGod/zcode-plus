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
const hb = src.match(/async\((\w+),(\w+)\)=>\{let (\w+)=(\w+)\.parse\(\1\),\w+=\3\.subagent_type\?\?\w+\.GeneralPurpose/);
if (!hb) { console.error("[ABORT] handler structure not found"); process.exit(1); }
const [, hIn, hCtx, hParsed] = hb;
const he = src.match(new RegExp(`throw (\\w+)\\((\\w+)\\.ConfigurationError,"SubagentPort is not configured for Agent tool"`));
if (!he) { console.error("[ABORT] handler error bindings not found"); process.exit(1); }
const [, hErr, hErrType] = he;
if (src.includes(VAR + "CallModel") || src.includes(VAR + "ResolveModelRef") || src.includes(VAR + "CallSel")) {
  console.error("[ABORT] injected identifier already present — already patched?"); process.exit(1);
}

// ---------- 1. AgentInputSchema:插入 model 参数 ----------
applyOnce(
  "schema.model-param",
  /(subagent_type:(\w+)\.string\(\)\.optional\(\)\.describe\("The type of specialized agent to use for this task"\),)/,
  (g) => g[1] +
    `model:${g[2]}.string().optional().describe("Model for the subagents (providerId/modelId, a bare modelId when unambiguous, optional $reasoning suffix). Resolved against this host's live model catalog at call time, including custom providers; an unknown name fails with the available list. Omit to let the agent's profile/settings decide."),`,
);

// ---------- 2. agentHandler:解析 model → callModel,并传入 launch options ----------
{
  const m2 = src.match(new RegExp(
    `"SubagentPort is not configured for Agent tool",\\{context:\\{code:\\w+\\.SUBAGENT_UNAVAILABLE,toolCallId:${hCtx}\\.toolCallId,toolName:"Agent"\\},recoverable:!1\\}\\);let \\w+=\\{sessionId:`,
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
    new RegExp(`("SubagentPort is not configured for Agent tool",\\{context:\\{code:\\w+\\.SUBAGENT_UNAVAILABLE,toolCallId:${hCtx}\\.toolCallId,toolName:"Agent"\\},recoverable:!1\\}\\);)(let \\w+=\\{sessionId:)`),
    (g) => g[1] + inject + g[2],
  );

  applyOnce(
    "handler.launch-options",
    /(\.\.\.(\w+)\.subagentModelOverride\?\{modelOverride:\2\.subagentModelOverride\}:\{\})(?=\}\))/,
    (g) => g[1] + `,callModel:${VAR}CallModel`,
  );
}

// ---------- 3. runner launch():后台分支透传 callModel 到 start ----------
applyOnce(
  "runner.launch.start-options",
  /(return \w+\.start\(\w+,\{signal:\w+\?\.signal,\.\.\.(\w+)\?\.model\?\{model:\2\.model\}:\{\})(?=\})/,
  (g) => g[1] + `,callModel:${g[2]}?.callModel`,
);

// ---------- 4. runner run():runAgentToCompletion 子集透传 ----------
applyOnce(
  "runner.run.subset",
  /(\.\.\.(\w+)\?\.modelOverride\?\{modelOverride:\2\.modelOverride\}:\{\})(?=\})/,
  (g) => g[1] + `,callModel:${g[2]}?.callModel`,
);

// ---------- 5. runner start():runBackgroundAgent 子集透传 ----------
applyOnce(
  "runner.start.subset",
  /(\{signal:\w+\.signal,\.\.\.(\w+)\?\.model\?\{model:\2\.model\}:\{\})(?=\},\{onSessionReady:)/,
  (g) => g[1] + `,callModel:${g[2]}?.callModel`,
);

// ---------- 6. runExploreAgent:callSelection 进解析器 + 抑制继承 ----------
applyOnce(
  "explore.overrideSelection",
  /(overrideSelection:(\w+)\?\.modelOverride\?\.selection,)(resolveSelection:)/,
  (g) => g[1] + `callSelection:${g[2]}?.callModel?.selection,` + g[3],
);
applyOnce(
  "explore.inherit-suppress",
  /(=(\w+)\?\.modelOverride,)(\w+)=!(\w+)&&!(\w+)\?(\w+)\?\.model:void 0/,
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
    /function (\w+)\((\w+)\)\{let (\w+)=\2\.profileSelection,/,
    (g) => `function ${g[1]}(${g[2]}){const ${VAR}CallSel=${g[2]}.callSelection;let ${g[3]}=${g[2]}.profileSelection,`,
  );
  // 优先级链:override ? A : [插入 callSel ? B] : profile ? C : parent
  applyOnce(
    "selection.callSelection-branch",
    /=\w+\.overrideSelection\?\{effectiveSelection:\w+\.overrideSelection\}:(\w+)\?(\w+\.resolveSelection)\?(\w+\.resolveSelection)\((\w+)\((\w+)\)\):\{effectiveSelection:\1\}/,
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
    /=(\w+)\.overrideSelection\?\?(\w+\?\?\w+\.parentSelection)/,
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
  /description:(\w+)\.description,prompt:(\w+)\.prompt,parentToolCallId:\2\.parentToolCallId,status:"running",allowedTools:/,
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
  /(agentType:(\w+)\.agentType,background:\2\.background,childSessionId:\2\.sessionId,)description:\2\.description,(parentSessionId:this\.sessionId)/,
  1,
  (g) => g[1] + `description:${g[2]}.description+(${chainExplore}?" \\u00b7 "+${chainExplore}:""),` + g[3],
);
} else {
  console.log("v2 already applied — skipping row-display");
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
    /(\w+)\.some\((\w+)=>\2\.name==="TodoWrite"\)&&(\w+)\((\w+)\.turnRequestState\.entries\)/,
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
    ? src.match(new RegExp(`async function ${mInit[1]}\\((\\w+)\\)\\{if\\(this\\.mcpToolsRegistered\\)return;`))
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
      // v4/v6 下表现为整会话无 MCP 无 ToolSearch);②error 带堆栈落日志便于定位
      const catchRe = new RegExp(`catch\\((\\w+)\\)\\{this\\.mcpToolsRegistered=!0,this\\.logger\\?\\.warn\\("MCP initialization failed",\\{\\.\\.\\.Sr\\(${trace}\\),error:\\1 instanceof Error\\?\\1\\.message:String\\(\\1\\),event:"mcp\\.initialization\\.failed",module:"core\\.runtime",status:"failed"\\}\\)\\}`);
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
      // XFo 卫语句改写:官方「n===void 0 → 早退」挡死了子代理端口(OFo 借用包装
      // 没有 toolListRevision 方法,ToolSearch 加载后永远静默不重注册,子代理对着
      // 「Loaded N tool(s)」幻影空转)。改为:revision 有值且未变才早退;子端口
      // (undefined)每回合走到签名对比,可见集未变时签名相同自然防抖。
      const xfoHeadOld = `async function ${xfo}(e){let t=this.mcpPort;if(!t||!this.mcpToolsRegistered)return;let n=t.toolListRevision?.();if(n===void 0||n===this.mcpToolListRevision)return;`;
      const xfoHeadNew = `async function ${xfo}(e){let t=this.mcpPort;if(!t||!this.mcpToolsRegistered)return;let n=t.toolListRevision?.();if(n!==void 0&&n===this.mcpToolListRevision)return;`;
      if (src.split(xfoHeadOld).length - 1 !== 1) {
        console.error("[WARN] v4: XFo guard anchor mismatch — subagent-port fallback not applied");
      } else {
        src = src.replace(xfoHeadOld, xfoHeadNew);
      }
      console.log("v4 applied: mcp live-toggle wired via refreshMcpToolsIfChanged");
    }
  }
}

// ============================================================
// v6:MCP 按需加载(ToolSearch——skill 式两段披露)
// ============================================================
// 会话出生不再注册任何 MCP 工具 Schema(上下文省掉大头),改为挂一个
// ToolSearch 内建工具:模型按关键词搜索连接池里的工具,命中的当场注册进
// 本会话(复用官方 XFo:unregister 旧 registeredMcpToolNames → 按过滤后
// 清单重注册 → invalidateToolCache),下一发请求即可调用,全会话持续。
// query '*' 全量加载;空 query 列出已连 server 与工具数。
// 实现:__zcodeMcpWanted(每会话 Set,键=serverName+toolName)为可见层;
// __zcodeMcpFilter 在 KFo/XFo 两处注册点过滤;__zcodeMcpSearchEntry 克隆
// TodoWrite 条目(策略字段全套继承)替换名字/描述/handler。
const v6Applied = src.includes("__zcodeMcpSearchEntry");
if (!v6Applied) {
  const mInit = src.match(/\(([\w$]+),"initializeMcp"\)/);
  const mRef = src.match(/\(([\w$]+),"refreshMcpToolsIfChanged"\)/);
  const headOk = mInit && mRef && src.includes(`async function ${mInit[1]}(e){async function __zcodeMcpSync(e){`);
  if (!headOk) {
    console.error("[WARN] v6: anchors missing/changed (v4 must be applied first) — skipping tool-search patch");
  } else {
    const xfo = mRef[1];
    // 两处注册点的局部名:KFo 是 X.tools 形态,XFo 是纯变量形态
    const regK = src.match(/([\w$]+)=([\w$]+)\(this\.registry,([\w$]+),([\w$]+)\.tools,\{allowedTools:this\.config\.toolAllowlist/);
    const regX = src.match(/([\w$]+)=([\w$]+)\(this\.registry,([\w$]+),([\w$]+),\{allowedTools:this\.config\.toolAllowlist/);
    const sigRec = src.match(/(this\.__zcodeMcpSrvSig=Object\.keys\((\w+)\.statuses\?\?\{\}\)\.sort\(\)\.join\(.{1,6}?\),)/);
    if (!regK || !regX || !sigRec) {
      console.error("[WARN] v6: register-call anchors not usable — skipping tool-search patch");
    } else {
      const FILTER = `function __zcodeMcpFilter(t){let w=this&&this.__zcodeMcpWanted;if(!w||w.size===0)return[];return t.filter(d=>w.has(d.serverName+"\\u0001"+d.toolName))}`;
      const FACTORY =
        `function __zcodeMcpSearchEntry(rt){let P=rt.registry.get("Read")||rt.registry.get("Grep")||rt.registry.get("TodoWrite");if(!P)return null;` +
        `let sCount=Object.keys(rt.config.mcp?.servers??{}).length;` +
        `return {capability:P.capability,inputSchema:{type:"object",properties:{query:{type:"string",description:"Keywords against server/tool names and descriptions. Empty = list connected servers. '*' = load every tool. Leading '-' = unload ('-' lists loaded, '-keywords' unloads matches, '-*' unloads all)."}}},outputSchema:{$schema:"http://json-schema.org/draft-07/schema#",type:"object",properties:{summary:{type:"string"},servers:{type:"string"},tools:{type:"array",items:{type:"string"}}},required:["summary"]},permission:P.permission,resultBudget:P.resultBudget,timeout:P.timeout,cancellation:P.cancellation,trace:P.trace,` +
        `metadata:{...P.metadata,name:"ToolSearch",readOnly:!0,destructive:!1,concurrentSafe:!0,needsApproval:!1,sideEffectScope:"session",` +
        `description:"Search & load MCP tools (tools from external MCP servers ONLY). Core built-in tools (Read, Grep, Glob, Bash, Edit, Write, TodoWrite, Agent, ...) are ALWAYS directly available without this tool - never search for them. This session starts with NO MCP tools loaded. Call with keywords (server or tool name, or what you need done) to search connected MCP servers - matched tools become immediately callable and stay loaded until unloaded. Empty query lists all connected servers with tool counts. query '*' loads every tool. Prefix '-' to unload: '-' lists loaded tools, '-keywords' unloads matches, '-*' unloads all. Currently connected: "+(sCount>0?sCount+" MCP server(s); call with empty query to see them all.":"(none)")+"."},` +
        `handler:async(i,c)=>{let port=rt.mcpPort;if(!port)return{summary:"MCP is not available in this session."};` +
        `let all;try{all=await port.listTools()}catch(err){return{summary:"MCP tool list unavailable: "+(err&&err.message||err)}}` +
        `let q=String((i&&i.query)||"").trim(),picks;` +
        `if(q[0]==="-"){let rest=q.slice(1).trim(),w=rt.__zcodeMcpWanted;if(!w||w.size===0)return{summary:"Nothing is loaded in this session yet."};if(!rest){let byL={};for(const k of w){let p2=k.split("\\u0001");(byL[p2[0]]=byL[p2[0]]||[]).push(p2[1])}return{summary:"Currently loaded MCP tools:",tools:Object.entries(byL).map(e2=>e2[0]+": "+e2[1].join(", "))}}if(rest==="*")w.clear();else{let toks2=rest.toLowerCase().split(/\\s+/).filter(Boolean);for(const k of [...w]){let hay2=k.toLowerCase();if(toks2.some(x=>hay2.includes(x)))w.delete(k)}}let left=[...w].map(k=>k.split("\\u0001")[0]+"/"+k.split("\\u0001")[1]);rt.mcpToolListRevision=void 0,rt.mcpToolsSignature=void 0;try{await XFo.call(rt,rt.rootTraceContext)}catch(err){return{summary:"MCP tool unload failed: "+(err&&err.message||err)}}return{summary:rest==="*"?"Unloaded all MCP tools from this session; call ToolSearch again to reload any.":"Unloaded matching tools. Still loaded and callable:",tools:left}}` +
        `if(q==="*")picks=all;else if(!q){let byS={};for(const t of all){(byS[t.serverName]=byS[t.serverName]||[]).push(t.toolName)}return{summary:"Connected MCP servers (nothing loaded yet - call with keywords, or '*' to load all):",servers:Object.keys(byS).map(s=>s+" ("+byS[s].length+" tools)").join(", ")||"(none)"}}` +
        `else{let toks=q.toLowerCase().split(/\\s+/).filter(Boolean);picks=all.map(t=>{let hay=(t.serverName+" "+t.toolName+" "+(t.description||"")).toLowerCase(),sc=0;for(const k of toks){let n=hay.split(k).length-1;if(n===0){sc=-1;break}sc+=n}return{t,sc}}).filter(x=>x.sc>=0).sort((a,b)=>b.sc-a.sc).slice(0,8).map(x=>x.t)}` +
        `if(picks.length===0)return{summary:"No MCP tool matches. Connected servers: "+[...new Set(all.map(t=>t.serverName))].join(", ")+"."};` +
        `let w=rt.__zcodeMcpWanted||(rt.__zcodeMcpWanted=new Set());for(const t of picks)w.add(t.serverName+"\\u0001"+t.toolName);` +
        `rt.mcpToolListRevision=void 0,rt.mcpToolsSignature=void 0;try{await ${xfo}.call(rt,rt.rootTraceContext)}catch(err){return{summary:"MCP tool load failed: "+(err&&err.message||err)}};` +
        `return{summary:"Loaded "+picks.length+" tool(s) into this session - callable now and visible in your tools from this point:",tools:picks.map(t=>t.serverName+"/"+t.toolName+": "+(t.description||"").slice(0,300))}}}}`;
      // 1) 注入过滤函数与工具工厂(KFo 之前,模块作用域,XFo/$bt 均可见)
      src = src.replace(`async function ${mInit[1]}(e){async function __zcodeMcpSync(e){`,
        FILTER + FACTORY + `async function ${mInit[1]}(e){async function __zcodeMcpSync(e){`);
      // 2) 两处注册点套可见层过滤
      src = src.replace(`${regK[2]}(this.registry,${regK[3]},${regK[4]}.tools,{allowedTools:this.config.toolAllowlist`,
        `${regK[2]}(this.registry,${regK[3]},__zcodeMcpFilter.call(this,${regK[4]}.tools),{allowedTools:this.config.toolAllowlist`);
      src = src.replace(`${regX[2]}(this.registry,${regX[3]},${regX[4]},{allowedTools:this.config.toolAllowlist`,
        `${regX[2]}(this.registry,${regX[3]},__zcodeMcpFilter.call(this,${regX[4]}),{allowedTools:this.config.toolAllowlist`);
      // 3) 首次注册路径:记完名单签名后挂 ToolSearch 本体
      src = src.replace(sigRec[1] + `this.logger?.info("MCP tools registered"`,
        sigRec[1] + `this.__zcodeMcpSearchReady=!0,(this.__zcodeMcpSearchEntryObj=__zcodeMcpSearchEntry(this))&&this.registry.register(this.__zcodeMcpSearchEntryObj),this.invalidateToolCache(),this.logger?.info("MCP tools registered"`);
      // 4) v4 助手升级:头部挂 ToolSearch 兜底创建;名单变化时把新出现服务器的
      //    工具并入按需清单(UI 显式启用即时生效),再强制走重注册
      src = src.replace(/async function __zcodeMcpSync\((\w)\)\{/,
        `async function __zcodeMcpSync($1){if(!this.__zcodeMcpSearchReady){this.__zcodeMcpSearchReady=!0;try{let se=__zcodeMcpSearchEntry(this);se&&this.registry.register(se),this.invalidateToolCache()}catch(i){}}`);
      const mSig = src.match(/let (\w)=await (\w)\.status\(\),(\w)=Object\.keys\(\1\)\.sort\(\)\.join\(","\);if\(\3!==this\.__zcodeMcpSrvSig\)\{this\.__zcodeMcpSrvSig=\3,this\.mcpToolListRevision=void 0\}/);
      if (mSig) {
        src = src.replace(
          `if(${mSig[3]}!==this.__zcodeMcpSrvSig){this.__zcodeMcpSrvSig=${mSig[3]},this.mcpToolListRevision=void 0}`,
          `if(${mSig[3]}!==this.__zcodeMcpSrvSig){if(this.__zcodeMcpSrvSig!==void 0){let o=new Set(this.__zcodeMcpSrvSig.split(",").filter(Boolean)),w=this.__zcodeMcpWanted||(this.__zcodeMcpWanted=new Set());try{let tl=await ${mSig[2]}.listTools();for(const t of tl)if(!o.has(t.serverName))w.add(t.serverName+"\\u0001"+t.toolName)}catch(e2){}}this.__zcodeMcpSrvSig=${mSig[3]},this.mcpToolListRevision=void 0}`,
        );
      } else {
        console.error("[WARN] v6: __zcodeMcpSync sig-change block not matched — UI-enable auto-load unavailable");
      }
      console.log("v6 applied: ToolSearch on-demand MCP loading wired");
    }
  }
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
