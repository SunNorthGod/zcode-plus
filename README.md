# zcode-plus

非官方 ZCode Desktop 增强补丁集(Unofficial enhancement patches for ZCode Desktop)。

六大能力:**ToolSearch MCP 无状态网关**(会话零 mcp__ schema,上下文省约 30%)、**子代理调用级选模**(Agent 工具直接指定这次用哪个模型)、**选模跨唤醒持久**(SendMessage 唤醒终态子代理不回落主模型,进程内)、**MCP 开关实时生效**(拨开关下一请求生效)、**分屏严格均分**(新建/关闭均重平衡)、**流中断线兜底**(中转流中限流/繁忙/断连不再一发死,走流中恢复重开,配额与风控类仍终态)。

- 本仓库只含补丁脚本,不含任何官方二进制;原版文件请从自己的安装包提取。
- 与 Z.ai 官方无关,按 MIT 协议开源;修改的是本机安装,自用请自行评估风险。
- 当前锚点验证通过的版本:**ZCode Desktop 3.15.3(Windows)**;3.15.1/3.15.2 基线留存于 pristine-3151|3152/,Node ≥ 22。

---

## 功能详述

### 1. ToolSearch —— MCP 无状态网关(v7,旗舰)

**为什么做**:ZCode 把所有已启用 MCP server 的工具 schema 全量塞进每个会话的系统提示。本机实测(60+ 服务器实例、656 个工具):MCP schema 占首发请求约 **30% 上下文**,且随对话常驻。对比之下,几百个技能的目录只占 ~0.2%——因为技能走「目录 + 用时展开」两段披露,工具却是单段全量披露。

**v7 的形态**(v6 按需装卸的换代,装卸本身也被证明对小模型是元认知负担,已移除):`mcp__` 工具**永远不注册**;会话只多一个无状态的 `ToolSearch` 网关,三个只读动词 + 一个透传动词,工具面从出生到死亡恒定不变:

| 调用 | 行为 |
|---|---|
| `ToolSearch {}` | 全目录:一行一工具 `server/tool: 描述`,超预算降级为按服务器分组 |
| `ToolSearch {query:"ida"}` | 关键词过滤目录;搜索面**仅 server/tool 名**(描述文本不参与匹配,杜绝子串劫持),OR 计分,部分命中也返回 |
| `ToolSearch {tool:"ida/decompile"}` | inspect:返回该工具的完整参数 schema 与描述 |
| `ToolSearch {tool:"ida/decompile", args:{...}}` | execute:真正执行,结果转文本返回 |

与 skill 的同构性:目录=skill 列表,inspect=skill 展开内容,execute=按 skill 指令干活。**没有任何调用改变工具面**:零加载、零卸载、零重注册,前缀缓存不被 MCP 打断;compact/resume 后零恢复成本——历史里的网关调用天然自解释,不存在「加载状态丢失」。

**原理**:
1. 两处注册点(`registerMcpTools` 首注册 / `refreshMcpToolsIfChanged` 重注册)的入参直接置空——mcp 工具一个不进注册表;
2. 挂一个 `ToolSearch` 内建工具(克隆现有工具条目继承策略字段,input/output schema 与 handler 返回形状严格匹配);
3. execute 路径**临场构造 vendor 的 `createMcpToolEntry` 结果但从不注册**,直接调用其 handler——权限声明、审批触发、结果预算、超时、trace、图像/内容格式化全部复用 vendor 原装实现,零复刻;
4. 网关内等价复刻 `registerMcpTools` 的 allowedTools/disallowedTools 白名单语义(受限 agent 场景照常受限),被禁工具直接拒绝。

顺带修了一个厂商坑:官方 `initializeMcp` 的 catch 会把 `mcpToolsRegistered` 置真,**一次注册失败 = 整会话永久无 MCP**。补丁改为失败不锁、下轮自动重试,并把异常堆栈落进日志。UI 开关实时生效(v4)保留:拨开关下一请求生效——目录每次都从连接池现查,开关变化自然反映在目录里。

### 2. 子代理调用级选模(v1)

**为什么做**:官方 Agent 工具故意不做调用级模型覆盖(担心历史 tool call 重放覆盖用户配置),agent profile 又只能静态绑定一个模型。实际编排里「这次派个便宜的干粗活、那次派个强的啃硬骨头」是高频需求。

**怎么用**:Agent 工具新增可选 `model` 参数:

```json
{ "subagent_type": "general-purpose",
  "description": "重构 auth 模块",
  "prompt": "...",
  "model": "anthropic/claude-opus-4.8$high" }
```

支持完整 `providerId/modelId`、裸 `modelId`(唯一匹配时)、`$档位` 后缀(推理等级)。解析失败会报错并列出当前可用模型清单。优先级:**宿主 override > 调用级 > profile > 继承父会话**;调用级在场时抑制父模型继承。自定义 provider 的模型天然支持(按宿主实时模型目录解析)。

**原理**:schema(zod)加可选参数 → handler 按宿主模型目录现查解析(含歧义/禁用/档位校验)→ launch/run/start 三条派发路径透传 `callModel` → 子代理选型解析器插入 callSelection 分支。不改任何提示词。

### 3. MCP 开关实时生效(v4)

**为什么做**:原版在设置里拨 MCP server 开关后,必须重启会话才生效。

**效果**:拨开关,当前会话下一发请求生效(关闭即卸载、开启即加载)。未变化的回合只多一次进程内状态读取。

**原理**:把上面那段厂商死代码 `refreshMcpToolsIfChanged` 接到 `initializeMcp` 的已注册闸门上(每回合走查);开关变化不会让官方的 `toolListRevision` 自增,所以补丁额外维护服务器名单签名,名单变化时强制清空版本号逼重注册。

### 4. claude 系 todo 提醒跳过(v3)

**为什么做**:turn-loop 每隔 10 轮未写 TodoWrite 就往对话尾部注入一条提醒(以 user 轮形态)。GLM 无感,但 claude 系模型会把「对话尾部新增 user 轮」误读为用户催促,导致行为跑偏。

**效果**:当前模型 modelId 含 `claude` 时自动跳过注入;只省略提醒,不影响 TodoWrite 工具本身。

### 5. 分屏严格均分(asar 渲染层补丁)

**为什么做**:拖拽分屏的官方逻辑是把目标 pane 对半砍——三格变 50/25/25,想要均分得手动拖。

**效果**:新建和关闭分屏时整棵布局树都按叶节点数重平衡,任意 N(≤4)格严格等宽;手动拖分隔条不受影响。

**流程**:

```bash
# 1) 从 app.asar 字节精确抽出渲染 chunk(路径以实际为准)
node asar-extract-one.cjs "C:\Program Files\ZCode\resources\app.asar" \
  "out/renderer/assets/styles-XXXX.js" styles.js

# 2) 打补丁(自动探测每版会变的混淆函数名,幂等)
node patch-pane-balance.mjs styles.js

# 3) 用 @electron/asar 重打包(注意:--unpack 只能一条 glob,多条会互相覆盖)
npx @electron/asar pack <解包目录> app.asar.new --unpack "**/*.{node,dll,exe}"

# 4) 提权换入(脚本会等 ZCode 完全退出、备份原文件、换入并重启)
swap-asar.cmd
```

---

## 快速开始(zcode.cjs 补丁)

```bash
# 打补丁(目录可写则直接换入;不可写则落到 %TEMP%,再跑 swap.cmd 提权换入)
node apply-model-param-patch.mjs "C:\Program Files\ZCode\resources\glm\zcode.cjs"

# 可选:跑 v7 回归验证(vm 里实跑 ToolSearch 目录/inspect/execute/白名单/零服务器九种形态 + 括号平衡)
node verify-v7.mjs

# 完全退出并重启 ZCode
```

回滚:

```bash
node apply-model-param-patch.mjs --restore "C:\Program Files\ZCode\resources\glm\zcode.cjs"
```

## 官方升级后重打

```bash
# 1) 从官方安装包提取该版本原版(7-Zip 两步)
7z e -y "ZCode-x.y.z-win-x64.exe" '$PLUGINSDIR/app-64.7z'
7z e -y app-64.7z "resources/glm/zcode.cjs" "resources/app.asar"

# 2) 用原版覆盖已装文件(或对着原版路径),重跑补丁脚本
node apply-model-param-patch.mjs "C:\Program Files\ZCode\resources\glm\zcode.cjs"

# 3) 回归验证
node verify-v7.mjs
```

官方重构导致锚点漂移时,脚本会**逐条点名失配位置并整体中止、不写盘**——照着报错更新正则即可,不会产生半打状态。

## 安全设计与已知边界

- 每处替换断言**恰好命中一次**,失配即中止;先写临时文件过 `node --check`,再原子换入;自动备份 `.orig-backup`。
- 锚点全部动态捕获(利用 esbuild keepNames 的注册字符串),压缩名变化不敏感。
- 编码铁律:`zcode.cjs` 是合法 UTF-8 文本,必须 utf8 读写;asar 里的渲染 chunk 含非 UTF-8 字节,必须 latin1 读写。混用会静默产生双重编码垃圾(语法仍合法,极难发现)。
- 已知边界:受限 agent(带 tools 白名单)的会话里网关同样注册,网关内复刻 allowedTools/disallowedTools 过滤,白名单语义与官方一致;execute 的结果文本经网关转写(上限 48KB),与直连调用 vendor 工具的返回形状不同;恢复的旧会话历史里可能有 v6 时代加载过的 `mcp__` 直连工具记录,新回合按 v7 语义经网关执行即可。
- 声明:仅供本机自用与研究;ZCode 为 Z.ai 产品,本仓库与其无关;请勿将官方二进制重新分发。

## License

MIT(仅覆盖本仓库脚本与文档)。
