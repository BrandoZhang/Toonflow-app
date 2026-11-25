# 多实例部署改造计划

本文件是执行清单，不代表任何一项已经实现。开工前同时阅读 [multiTenantContext.md](multiTenantContext.md) 与 [multiTenant.md](multiTenant.md)；本计划与两者冲突的地方在“需同步修改的既有规则”一节列出，由对应 PR 一并修改。

## 目标

Toonflow 服务端可以在负载均衡后运行 N 个实例，共同连接一个 MySQL 8.0 或 PostgreSQL RDS。任意请求落到任意实例都得到相同结果；任一实例退出后，其他实例接管或明确标记它留下的运行与任务。

Agent Runtime 当前运行在服务端进程内，工具使用服务端文件系统或本地沙箱进程。本计划把 Runtime 与宿主之间的依赖收敛成一个可序列化的能力接口，使将来整个 Agent 运行在远程沙箱中（agent-in-sandbox）时只需新增接口的远程实现。本计划不开发任何沙箱供应商适配。

桌面端、Android 与单机 Docker 继续使用 SQLite、本地文件和进程内协调，行为不变。

## 完成判定

以下场景在本地 compose 环境（2 个服务实例、1 个 MySQL 或 PostgreSQL、1 个共享卷、1 个轮询负载均衡）中全部通过，即视为完成：

1. 同一账号的连续请求轮流落到两个实例，登录、超管后台、设置保存、项目列表、画布读写全部成功；两个页面同时保存同一画布时，后保存的一方收到 `409` 并保留本地修改。
2. 在实例 A 发起 Agent 对话，Agent 调用 `askUser` 与画布操作；浏览器的回答和画布结果经负载均衡落到实例 B，A 上的运行照常继续。停止、排队、插队请求落到 B 时同样生效。
3. Agent 运行中刷新页面，新连接落到另一个实例，从断点续收事件，不丢失、不重复。
4. 媒体生成任务提交到 A，状态轮询落到 B，供应商任务只提交一次、只扣费一次；杀掉 A 后，租约到期，B 接管恢复或标记中断，预占金额被结算或释放。
5. 两个实例同时启动时，只有迁移命令修改表结构；结构版本不匹配的实例拒绝启动并给出明确错误。
6. 在 A 安装或更新插件，B 在一个刷新周期内加载新版本。
7. 同一份代码以桌面模式启动，使用 SQLite，行为与改造前一致。

验证不新增测试文件或测试依赖（见 `AGENTS.md`「测试与检查边界」）。每个 PR 使用 `typecheck`、`build`，以及临时目录、临时数据库上的手动 HTTP 和浏览器验证；不得连接线上 RDS 或 OSS。

## 现状要点

以下结论来自 2026-11-24 的代码盘点，文件位置以当时的仓库为准。

- 协调全部在进程内。`busyFiles`（`apps/server/src/utils/workspace/files.ts:132`）保护所有工作区写入；`activeSessions` 与 `activeRuns`（`agent/runtime/sessions.ts:73,81`）持有活动 Agent；`pendingCalls` 与 `pendingQuestions`（`agent/bridge/canvas.ts:11`、`question.ts:8`）等待浏览器回调。
- 媒体任务在另一实例上会被重复提交。`utils/media/tasks.ts:520` 在 `!task.active` 且状态为 `running` 时重新 `launch`，而 `active` 只在提交它的进程内为真。
- 超管会话只在登录的那个实例有效。`authorize` 要求令牌与进程内的 `adminSessionHash` 一致（`packages/multiTenant/auth/index.ts:28,134`）。
- `settings.json`（`utils/conf/index.ts`）保存供应商、MCP、网络、插件配置和 `multiTenantEnabled`。保存方式是整文件覆盖，靠进程内的 `saveQueue` 排队，没有版本校验。
- 数据库层有 8 张表，SQLite 与 MySQL 各定义一份；`AdminDatabase` 的 33 个方法在 `sqlite.ts` 与 `mysql.ts` 中各实现一遍。表结构由请求路径上的 `initialize()` 惰性创建并 `ALTER`，没有结构版本表。每个业务包各自打开连接池，每个实例最多 4 个池、20 个连接。
- 浏览器持有画布的最新状态和项目登记。画布整文件保存，不带 `expectedRevision`；项目用服务端绝对路径标识，所有接口都传 `directory`。
- Agent 运行绑定在 HTTP 响应上：连接断开就中止运行，事件没有序号，无法续传。
- 固定端口与本机身份：`10888`、`43123`、MCP 回环端口、桌面主机 secret，都假定只有一个进程、请求来自本机。

## 设计决策

### 部署形态是一个启动参数

新增 `TOONFLOW_DEPLOYMENT=standalone|cluster`，默认 `standalone`。启动时解析成一个 `DeploymentProfile`，由它一次性选出各项适配器，业务代码不再分散判断部署形态：

| 能力 | standalone | cluster |
| --- | --- | --- |
| 关系数据库 | SQLite（多租户关闭时不连接） | MySQL 8.0 或 PostgreSQL，必填 |
| 平台设置 | `settings.json` | 数据库 `platformSettings` 表，带 revision |
| 协调（锁、租约、运行归属） | 进程内实现，即现有代码 | 数据库租约表 |
| 跨实例命令 | 直接调用 | 按归属转发到持有实例 |
| 项目存储 | 本地目录 | 所有实例挂载到同一路径的共享 POSIX 卷 |
| 桌面、设备互联、主机 secret、`10888` 分端口 | 保留 | 禁用，路由返回 `404` |

`cluster` 形态要求开启多租户，并且必须提供 `TOONFLOW_MULTI_TENANT_SECRET` 与内部通信密钥 `TOONFLOW_CLUSTER_SECRET`；缺少任一项时拒绝启动。这一取舍可以撤回：如果以后需要“单用户集群”，在 `DeploymentProfile` 中放开即可。

### 跨实例协调用数据库租约加按归属转发，不引入 Redis

需要跨实例的状态分成两类：

- 必须正确的共享状态，包括文件锁、运行归属、媒体任务认领。这类状态放进数据库的 `clusterLease` 表，用条件更新认领，带过期时间和递增的 fencing token，持有者定期续约。实例崩溃后，租约到期即可被他人认领，不需要清理脚本。
- 只有持有实例才能处理的请求，包括回答提问、画布回调、停止运行、浏览器会话、ffmpeg 取消、插件服务隧道、MCP 控制连接。实例在 `clusterInstance` 表登记自己的内部地址并定期心跳；收到请求的实例按资源 key 查出持有者，再用 `TOONFLOW_CLUSTER_SECRET` 签名的内部 HTTP 请求转发过去。持有者就是自己时直接处理。

选择这个方案的理由：MySQL 与 PostgreSQL 都能实现，不增加新的必备基础设施；单机形态下转发退化为直接调用。代价是每次受协调的写入多一次数据库往返。PR 5 先测量这次往返，如果超出预算，再在同一接口后面增加 Redis 实现，调用方不需要改。

Agent 事件续传也用数据库：事件按 `(runId, seq)` 追加到 `agentRunEvent` 表，客户端带 `after=seq` 续收。持有实例在内存中直接推送实时事件，其他实例轮询该表。运行结束后，按保留期限清理事件行；清理属于删除操作，上线前按 `AGENTS.md` 单独确认。

### 项目文件第一阶段使用共享卷，对象存储放在接口之后

工作区里有画布 JSON、素材、对 `.agent/sessions/*.jsonl` 的追加写入，ffmpeg、puppeteer 与沙箱也直接读写文件。第一阶段改成对象存储，需要重写所有工具，所以先要求共享 POSIX 卷（NAS、EFS 或 CSI 卷），以 `TOONFLOW_DATA_DIR` 挂载到所有实例。

这一阶段要做三件事：

- 跨实例的写入互斥由数据库租约提供，不再依赖进程内的 `busyFiles`。
- 对外只使用 `projectId` 加项目内相对路径，不再传绝对路径。
- 所有文件访问经过 `WorkspaceStore` 接口，将来对象存储作为它的另一个实现接入。

### Agent Runtime 只依赖可序列化的 `AgentHost` 接口

Runtime 对宿主的全部依赖收敛到一个接口，入参和返回值都可以序列化成 JSON：

```ts
type AgentHost = {
  run: { runId: string; projectId: string; actor: ActorRef; sessionFile: string };
  model: { stream(request: ModelRequest, signal: AbortSignal): AsyncIterable<ModelEvent> };
  files: WorkspaceFiles;          // 仅项目内相对路径
  sessions: { read(file: string): Promise<SessionEntry[]>; append(file: string, entries: SessionEntry[]): Promise<void> };
  canvas?: { call(request: CanvasToolCall, signal: AbortSignal): Promise<unknown> };
  question?: { ask(toolCallId: string, request: QuestionRequest, signal: AbortSignal): Promise<QuestionAnswer> };
  media?: MediaContext;
  tools: { execute(name: string, args: unknown, signal: AbortSignal): Promise<ToolResult> };
  emit(event: AgentEvent): void;  // 宿主负责编号、落库与分发
};
```

这个接口要满足五项约束：

- 模型调用只经过宿主的 `model.stream`，网关、计费和供应商凭据都留在宿主，Runtime 拿不到 API key。现有的 `requests.ts` 中 `streamFunction` 就是这个入口。
- `actor` 显式放在运行记录里，不再从 AsyncLocalStorage 读取。
- 文件只用相对路径。删除 `resolvePath` 返回宿主绝对路径的能力；只有确实需要真实路径的工具（ffmpeg、沙箱导入导出）才在宿主侧执行，通过 `tools.execute` 调用。
- 会话记录的读写经过 `sessions`，JSONL 格式不变。
- 运行状态（排队、待回调、子 Agent）记录在 `agentRun` 表，不依赖进程内对象。

当前只实现一个进程内的 `AgentHost`。将来实现 agent-in-sandbox 时，在沙箱内把同一接口实现为调用宿主内部 API 的客户端，宿主侧用同一套转发与事件机制服务它。工具放进沙箱执行（tool-in-sandbox）则在宿主侧 `tools.execute` 后面增加 `SandboxProvider` 接口，`just-bash` 本地进程作为默认实现；本计划只定义这个接口，不接入任何远程供应商。

### 数据库只保留两套实现

PostgreSQL 与 MySQL 合并为一套异步实现，方言差异集中到一个小适配器中处理：upsert、受影响行数、错误码、`information_schema` 查询。SQLite 保持独立实现，因为它是同步事务（`.immediate()`），并且只用于单机。表定义改成一处描述、三处生成，或者保留三套声明但共用同一份实现；两种做法由 PR 2 的原型比较后决定，判定标准是新增一个字段时需要改动的文件数。

表结构改由单独的 `bun run migrate` 命令执行：持有迁移租约，写入 `schemaVersion` 表。请求路径上不再执行 `CREATE` 和 `ALTER`。实例启动时只读取结构版本，与代码要求的版本不一致时拒绝启动。单机形态在启动时自动执行同一迁移，行为与现在相同。

### 需同步修改的既有规则

- `multiTenant.md` 中的“同时支持 SQLite 与 MySQL 8.0”改为“SQLite、MySQL 8.0 与 PostgreSQL”，由 PR 2 修改。
- “同一部署保持一个 Bun 进程”中的“部署”明确指单个实例，集群是同一应用的多个实例，由 PR 0 修改。
- “迁移使用独立发布步骤”在 PR 1 实现后，把文档从约束改写为现状说明。

## 落地顺序与依赖

```text
PR0 部署形态与集群启动保护
 └─ PR1 迁移命令与结构版本
     └─ PR2 PostgreSQL 与方言合并
         ├─ PR3 超管会话与登录计数        （独立）
         ├─ PR4 平台设置入库              （独立）
         └─ PR5 实例登记、租约与转发
             ├─ PR6 项目登记与画布版本
             ├─ PR7 媒体任务认领
             └─ PR8 回调与命令转发
                 └─ PR9 Agent 运行与 HTTP 解耦
                     └─ PR10 AgentHost 接口
PR4 ─ PR11 插件与供应商脚本分发
全部 ─ PR12 集群部署样例与端到端验证
```

PR3、PR4、PR5 都只依赖 PR2，可以并行，三者修改的文件互不重叠。PR6、PR7、PR8 依赖 PR5，彼此独立，可以并行。PR6 与 PR9 修改用户可见交互（项目选择、画布冲突提示、断线续传），合并前需要用户评审。

## 各 PR 清单

### PR0 部署形态与集群启动保护

- [ ] 依赖：无
- [ ] 修改范围：`apps/server/src/index.ts`、`app.ts`、新增 `lib/deployment.ts`；`utils/mobileLink`、`utils/multiTenant/runtime.ts`、`utils/mcp/runtime.ts`、`routes/desktop/**` 的启动入口；`.agent/multiTenant.md`
- [ ] 改动：解析 `TOONFLOW_DEPLOYMENT`，生成实例 ID；`cluster` 形态校验必需的环境变量和数据库类型，关闭桌面路由、设备互联、主机 secret、`10888` 分端口与 MCP 回环监听。
- [ ] 结果：`cluster` 形态缺少 secret 或使用 SQLite 时启动失败，错误信息说明原因；`standalone` 形态的启动日志和路由表与改造前一致。
- [ ] 验证：`typecheck` 与 `build`。比较两种形态生成的路由清单；在临时目录启动 `standalone`，抽查首页、设置、项目读写。

### PR1 迁移命令与结构版本

- [ ] 依赖：PR0
- [ ] 修改范围：`packages/multiTenant/db/*`；`auth`、`billing`、`models`、`sourceMapping`、`gateway` 中调用 `initialize*` 的位置；`apps/server/package.json` 增加 `migrate` 脚本
- [ ] 改动：新增 `schemaVersion` 表与有序迁移列表，把现有 `CREATE` 与 `ALTER` 原样迁入第 1 版；删除请求路径上的惰性 `initialize`；启动时检查版本。
- [ ] 结果：对空库执行两次 `migrate`，第二次不做任何修改；不执行迁移就以 `cluster` 形态启动，报出版本不匹配。
- [ ] 验证：用临时 MySQL 与旧结构的 SQLite 副本，各执行一次迁移，前后导出表结构比较；同时启动两个 `migrate` 进程，确认只有一个获得迁移租约。

### PR2 PostgreSQL 与方言合并

- [ ] 依赖：PR1
- [ ] 修改范围：`packages/multiTenant/db/*`（新增 `pg` 驱动依赖）、`models/secret.ts`、`.agent/multiTenant.md`
- [ ] 改动：先做原型，比较两种表定义方案；合并 MySQL 与 PostgreSQL 的实现；事务内的重复键处理改为 `onConflictDoNothing().returning()`；对死锁与序列化失败做有界重试，只重试纯数据库操作；全进程共用一个连接池，池大小由 `TOONFLOW_DB_POOL_SIZE` 配置。
- [ ] 结果：`dataSource` 支持 `postgres`；33 个方法在 MySQL 与 PostgreSQL 上行为一致。
- [ ] 验证：在临时 MySQL 与临时 PostgreSQL 上，各跑一遍注册、登录、设置 CAS、钱包充值、预占、结算、释放的 HTTP 流程；两个进程并发预占同一钱包，余额与账本一致。
- [ ] 性能：记录改造前 MySQL 上登录与预占接口的 p50 和 p95 作为基线；PostgreSQL 与改造后的 MySQL 不得超过基线的 1.2 倍。

### PR3 超管会话与登录计数

- [ ] 依赖：PR2
- [ ] 修改范围：`packages/multiTenant/auth/index.ts`、`db` 中与 admin 相关的方法
- [ ] 改动：超管会话只以数据库为准，删除 `adminSessionHash`；`failedAttempts` 改为原子自增；用数据库唯一约束替代进程内的 `serial()` 保证首次设置只成功一次。
- [ ] 结果：在 A 登录超管后台，B 上的管理接口返回 `200`；对两个实例并发提交错误密码，累计次数准确，到阈值后锁定。
- [ ] 验证：两个实例连接同一个临时数据库，手动执行上述场景。

### PR4 平台设置入库

- [ ] 依赖：PR2
- [ ] 修改范围：`apps/server/src/utils/conf/*`、`routes/settings/*`、`utils/network/transport.ts`、`utils/mcp/servers.ts`、`packages/multiTenant/gateway` 中的缓存
- [ ] 改动：`cluster` 形态下，`u.conf` 的读写由 `platformSettings` 表提供，保存时带 revision 做 CAS。各实例按 revision 变化重建网络代理、MCP 客户端和网关缓存，检测方式是读取时比较或短周期轮询。`standalone` 形态继续使用 `settings.json`。
- [ ] 结果：在 A 修改代理或供应商配置，B 在一个刷新周期内生效；两个页面基于同一 revision 保存时，后保存的一方收到 `409`。
- [ ] 验证：两实例手动验证；在 `standalone` 形态下确认 `settings.json` 的字节内容和保存行为不变。

### PR5 实例登记、租约与转发

- [ ] 依赖：PR2
- [ ] 修改范围：新增 `apps/server/src/utils/cluster/`（`instances.ts`、`lease.ts`、`forward.ts`）；`utils/workspace/files.ts` 的 `lockWorkspaceFiles`
- [ ] 改动：新增 `clusterInstance` 表（实例 ID、内部地址、心跳时间）和 `clusterLease` 表（key、持有者、过期时间、fencing token）；`lockWorkspaceFiles` 改用 `LockService` 接口，单机为现有实现，集群为数据库租约，保留按路径前缀判断冲突的语义；新增 `forwardToOwner(key)` 中间件。
- [ ] 结果：两个实例同时写同一路径，一方收到 `409 EBUSY`；持有锁的实例被杀掉后，租约到期即可再次获得。
- [ ] 验证：两实例并发写入，手动验证；强杀进程后观察租约过期。
- [ ] 性能：在单个文件写接口上测量加锁带来的额外延迟。基线是改造前的本地锁；p95 额外延迟超过 10 ms 时，在 `LockService` 后增加 Redis 实现，再重新测量。

### PR6 项目登记与画布版本

- [ ] 依赖：PR5；合并前需要用户评审
- [ ] 修改范围：`db` 新增 `project` 表；`apps/server/src/utils/workspace/*`、`routes/workspaces/**`；`apps/web/src/lib/workspaceFiles.ts`、`stores/workspace.ts`、画布面板 `index.vue` 的保存逻辑；`packages/nodeScaffold`、`nodeShared` 中对 `directory` 的使用
- [ ] 改动：项目登记 `projectId`、所属用户和共享卷内的相对存储路径；接口改为接收 `projectId`，旧的 `directory` 参数只在 `standalone` 下解析成 `projectId`；画布保存携带 `expectedRevision`，冲突时提示用户并保留本地修改；`mediaTask.directory` 改为 `projectId`。
- [ ] 结果：浏览器发出的请求里不再出现服务端绝对路径；两个页面编辑同一画布时，出现可见的冲突提示，本地修改没有丢失。
- [ ] 验证：在浏览器中打开两个窗口，按上述场景操作；旧项目在 `standalone` 下照常打开，画布、素材和对话格式不变。

### PR7 媒体任务认领

- [ ] 依赖：PR5
- [ ] 修改范围：`apps/server/src/utils/media/tasks.ts`、`utils/media/billing.ts`、`packages/multiTenant/billing`
- [ ] 改动：任务记录移入 `mediaTask` 表；执行前通过租约认领，状态查询只读取记录，只有租约过期时才重新认领并恢复。预占记录关联任务租约，租约过期且供应商确认未提交时释放预占。供应商余额账户 ID 改用 `TOONFLOW_CLUSTER_SECRET` 派生，不再用每次启动随机生成的密钥。
- [ ] 结果：完成判定第 4 条通过；本地文件中的旧任务记录在迁移时导入，`standalone` 下照常恢复。
- [ ] 验证：用临时供应商脚本模拟一个慢速供应商，统计它收到的提交次数，并核对账本条目。

### PR8 回调与命令转发

- [ ] 依赖：PR5
- [ ] 修改范围：`routes/agent/{answer,canvasResult,stop,queue*}.ts`、`routes/singleAgent/*`、`routes/browser/*`、`routes/ffmpeg/execute.ts`、`utils/pluginServer/*`、`utils/mcp/control.ts`、`agent/a2a/*`
- [ ] 改动：每个持有进程内对象的资源（运行、提问、画布调用、浏览器会话、ffmpeg 执行、插件服务、MCP 控制连接、A2A 任务）在创建时登记归属租约；相关请求经 `forwardToOwner` 送达持有实例；持有实例消失时返回明确错误，不静默成功。
- [ ] 结果：完成判定第 2 条通过。
- [ ] 验证：两实例加轮询负载均衡，逐个接口手动验证。

### PR9 Agent 运行与 HTTP 解耦

- [ ] 依赖：PR8；合并前需要用户评审
- [ ] 修改范围：`routes/agent.ts`、`agent/runtime/{index,sessions,types}.ts`、`apps/web/src/components/agent/conversation.vue`
- [ ] 改动：新增 `agentRun` 表（状态、持有者、队列、待回调）和 `agentRunEvent` 表（`runId`、`seq`、事件）；每个事件带 `seq`；连接断开不再中止运行，由显式停止或租约过期结束；新增 `GET /api/agent/events?runId&after=` 续收事件；前端断线后自动续传。
- [ ] 结果：完成判定第 3 条通过；持有实例被杀掉后，运行在租约过期后标记为中断，与现有“上次运行已中断”的展示一致。
- [ ] 验证：浏览器中在运行过程中刷新、切换网络、强杀持有实例，逐项观察。

### PR10 AgentHost 接口

- [ ] 依赖：PR9
- [ ] 修改范围：`agent/runtime/*`、`agent/tools/index.ts`、`agent/bridge/*`、`packages/toolScaffold/src/runtime.ts`、`packages/tools/sandbox/src/host.ts`
- [ ] 改动：按设计实现进程内的 `AgentHost`，Runtime 只通过它访问宿主；删除向工具暴露绝对路径的接口；`actor` 改为显式传入；定义 `SandboxProvider` 接口，`just-bash` 作为默认实现。先确认 pi-coding-agent 的 `SessionManager` 能否接入 `sessions` 接口；不能接入时，记录需要补丁的位置，再决定是否扩展现有补丁。
- [ ] 结果：`agent/runtime` 中不再直接调用 `@toonflow/file`、`resolveWorkspace` 或读取 `u.conf`，用 `rg` 检查即可确认。
- [ ] 验证：用 `rg` 确认上述引用为零；在浏览器中跑一遍包含画布、提问、媒体生成、沙箱、子 Agent 的对话，结果与改造前一致。

### PR11 插件与供应商脚本分发

- [ ] 依赖：PR4
- [ ] 修改范围：`app.ts` 的插件初始化、`utils/plugins/*`、`utils/teams/*`、`utils/media/provider.ts`
- [ ] 改动：内置插件复制从每次启动移入迁移命令；`cluster` 形态下，安装、更新、卸载插件和供应商脚本时，写入共享卷并推进数据库里的 `pluginRevision`；各实例检测到 revision 变化后清理模块缓存并重新加载。
- [ ] 结果：完成判定第 6 条通过；两个实例同时启动时不重复复制，也不会用旧的构建产物覆盖用户更新。
- [ ] 验证：两实例手动安装和更新一个插件，并检查共享卷中的文件。

### PR12 集群部署样例与端到端验证

- [ ] 依赖：全部
- [ ] 修改范围：`compose.yaml` 增加集群样例 profile、`Dockerfile`、`docs/` 下的部署说明
- [ ] 改动：提供 2 实例加 MySQL、2 实例加 PostgreSQL 两套本地样例，包含共享卷与轮询负载均衡；部署说明写清迁移步骤、必需的环境变量和健康检查。
- [ ] 结果：完成判定第 1 至 7 条在两种数据库上全部通过。
- [ ] 验证：逐条执行完成判定，并在本文件末尾记录每条的结果与日期。

## 不在本计划内

- 实时多人协同编辑（CRDT 或操作广播）。PR6 只提供冲突检测。
- 服务端执行整张画布（DAG 执行器）。画布节点的执行逻辑仍在浏览器中。
- 对象存储实现。PR6 留出 `WorkspaceStore` 接口。
- agent-in-sandbox 与远程沙箱供应商的开发。PR10 只定义接口。
- 组织租户、成员关系、项目共享。PR6 的 `project` 表只记录所属用户，表结构为增加租户列预留空间。
- OpenTelemetry。PR0 引入的实例 ID 会写入日志，便于以后接入。

## 尚未验证

- 单次租约往返的延迟是否在预算内。由 PR5 测量。
- pi-coding-agent 的 `SessionManager` 能否不依赖本地文件。由 PR10 确认。
- 共享卷上原子 rename 与追加写入的可靠性。各家 NAS 行为不同，由 PR12 在目标云环境中确认。
