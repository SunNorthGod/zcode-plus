# zcode-plus

非官方 ZCode Desktop 增强补丁集(Unofficial enhancement patches for ZCode Desktop)。

四大能力:**ToolSearch 按需加载 MCP**(会话出生零工具 schema,上下文省约 30%)、**子代理调用级选模**(Agent 工具直接指定这次用哪个模型)、**MCP 开关实时生效**(拨开关下一请求生效)、**分屏严格均分**。

- 本仓库只含补丁脚本,不含任何官方二进制;原版文件请从自己的安装包提取。
- 与 Z.ai 官方无关,按 MIT 协议开源;修改的是本机安装,自用请自行评估风险。
- 当前锚点验证通过的版本:**ZCode Desktop 3.15.1(Windows)**,Node ≥ 22。

---

## 功能详述

### 1. ToolSearch —— MCP 按需加载(v6,旗舰)

**为什么做**:ZCode 把所有已启用 MCP server 的工具 schema 全量塞进每个会话的系统提示。本机实测(60+ 服务器实例、656 个工具):MCP schema 占首发请求约 **30% 上下文**,且随对话常驻。对比之下,几百个技能的目录只占 ~0.2%——因为技能走「目录 + 用时展开」两段披露,工具却是单段全量披露。官方尚未上线按需加载(其 compact 代码里留有过渡期注释)。

**效果**:新会话工具列表里**一个 `mcp__` 都没有**,只多一个 `ToolSearch`。模型需要什么能力,当场搜索、当场加载、当回合可调用;不需要的永远不进上下文。

**怎么用**(模型自己会做,人也可以在对话里说「先 ToolSearch 搜 wind」):

| 调用 | 行为 |
|---|---|
| `ToolSearch {query: "wind"}` | 按关键词搜连接池,命中(前 8)当场加载进本会话 |
| `ToolSearch {}` | 空查询,列出全部已连接服务器与工具数 |
| `ToolSearch {query: "*"}` | 加载全部工具 |
| `ToolSearch {query: "-"}` | 列出本会话已加载的工具 |
| `ToolSearch {query: "-wind"}` | 卸载匹配的工具,立即退出工具列表 |
| `ToolSearch {query: "-*"}` | 全部卸载 |

已加载的工具全会话持续可用;每次加载/卸载各触发一次前缀缓存重建(代价远小于 30% schema 常驻)。UI 里显式启用的服务器,工具自动并入当前会话。

**原理**:厂商运行时本来就有完整的注册管线——`registerMcpTools`(会话初始化时注册)与 `refreshMcpToolsIfChanged`(工具清单变化时重注册,但出厂时没有任何调用方,是段死代码)。补丁做三件事:
1. 在两处注册点插入**会话级可见集过滤**(`__zcodeMcpWanted`,键 = 服务器 + 工具名):可见集为空则一个 MCP 工具都不注册;
2. 注册一个 `ToolSearch` 内建工具(克隆现有工具条目以继承权限/超时/预算/取消策略,input/output schema 与 handler 返回形状严格匹配),其 handler 搜索**进程级连接池**,命中写入可见集,然后清空版本号与签名逼 `refreshMcpToolsIfChanged` 走一遍注销→重注册→缓存失效,下一发请求即见;
3. 服务器名单签名 diff:UI 开关引起连接/断开时(这类变化不动官方的 `toolListRevision` 版本号),新出现的服务器工具自动并入可见集。

顺带修了一个厂商坑:官方 `initializeMcp` 的 catch 会把 `mcpToolsRegistered` 置真,**一次注册失败 = 整会话永久无 MCP**。补丁改为失败不锁、下轮自动重试,并把异常堆栈落进日志。

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

**效果**:新建分屏时整棵布局树按叶节点数重平衡,任意 N(≤4)格严格等宽;手动拖分隔条不受影响。

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

# 可选:跑 v6 回归验证(vm 里实跑 ToolSearch 七种返回形态 + 状态机断言)
node verify-v6b.mjs

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
node verify-v6b.mjs
```

官方重构导致锚点漂移时,脚本会**逐条点名失配位置并整体中止、不写盘**——照着报错更新正则即可,不会产生半打状态。

## 安全设计与已知边界

- 每处替换断言**恰好命中一次**,失配即中止;先写临时文件过 `node --check`,再原子换入;自动备份 `.orig-backup`。
- 锚点全部动态捕获(利用 esbuild keepNames 的注册字符串),压缩名变化不敏感。
- 编码铁律:`zcode.cjs` 是合法 UTF-8 文本,必须 utf8 读写;asar 里的渲染 chunk 含非 UTF-8 字节,必须 latin1 读写。混用会静默产生双重编码垃圾(语法仍合法,极难发现)。
- 已知边界:受限 agent(带 tools 白名单)的会话里 ToolSearch 也会注册,但加载仍走与官方一致的 allowedTools 过滤;恢复的旧会话历史里可能有当时加载过的 `mcp__` 工具记录,模型需要重新 ToolSearch;每次工具集变化触发一次前缀缓存重建,属预期成本。
- 声明:仅供本机自用与研究;ZCode 为 Z.ai 产品,本仓库与其无关;请勿将官方二进制重新分发。

## License

MIT(仅覆盖本仓库脚本与文档)。
