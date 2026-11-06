# oc2-ulw-plan 实施计划

状态：执行中
基线：OpenCode 2.2.5、@opencode/plugin 2.2.5、Node >= 22.19
参考：beiyanpiki/dsh-ulw-plan@d32c3b1aebead1ea5751185f82e532ba8dfd664d

## 目标

交付一个 OpenCode V2 原生插件，提供 Plan → Spec → Execute 的轻量实施闭环：

- 三个用户命令：`/ulw-plan`、`/ulw-execute`、`/ulw-status`。
- 冻结的 spec、独立运行状态、真实验收证据。
- 已确认角色：Planner、Executor、A Explorer、B Librarian、C Consultant、D Practical Reviewer、E Adversarial Reviewer、F Implementation Worker、G Independent Verifier、H Product Code Reviewer。
- 默认主代理直接实施；F 与 worktree 为显式可选能力。
- 不自动 commit、push、建 PR 或 merge；不覆盖用户已有修改。

## 非目标

- 不兼容 DSH/Codex/OpenCode V1。
- 不移植 DSH 双模型审批、lease、Boulder。
- 不默认创建 worktree，不默认并行委托。
- 不依赖实验性 todo、idle hook、session wait 或 LSP。
- 不宣称插件是操作系统沙箱。

## 关键契约

### Spec

单文件 `.opencode/ulw/specs/<id>.md`；YAML frontmatter 保存机器契约，Markdown 保存设计说明。整个文件字节 hash 是版本身份。运行进度不写回 spec。

必需内容：

- `schema: ulw-spec/v1`
- `id`
- `sources`（可选，记录原始需求文件及 hash）
- `requirements[]`：R1...
- `nonGoals[]`
- `tasks[]`：T1...，含依赖、文件范围、验收项
- `checks[]`：V1...，command 或 procedure
- review/risk 信息

### 状态

Spec：`draft → validating → reviewing → ready | changes_requested | blocked`

Task：`pending → running → checking → checked → passed | blocked`

Run：`preparing → running → final_verification → succeeded | paused | blocked | stale | failed`

只有全部必需任务完成、必需检查对最终代码有效、G 与 H 均明确通过、无活动受管作业且报告已持久化，才能进入 `succeeded`。

### 角色

- Planner：规划，不实施。
- Executor：实施；默认直接修改代码。
- A Explorer：按需代码探索。
- B Librarian：按需外部研究。
- C Consultant：复杂规划取舍时调用。
- D Practical Reviewer：每个待执行 spec 必须独立评审。
- E Adversarial Reviewer：高风险或 `--strict`，可被升级要求。
- F Implementation Worker：显式 `--parallel` 且任务独立。
- G Independent Verifier：最终产品验收，独立会话。
- H Product Code Reviewer：最终实际 diff 评审，独立会话。

Profile 复用：`ulw-plan`、`ulw-exec`、`ulw-readonly`、`ulw-verifier`、`ulw-worker`。

### 安全与可靠性

- 单工作区单活跃执行者，原子锁，不按超时抢锁。
- 恢复必须重新检查现场；在途检查不得补成成功。
- 验收命令使用 argv、权限检查、超时、取消与输出上限。
- 验收后代码变化使证据失效。
- 记录执行前基线；与用户修改重叠时阻塞，不自动 reset/stash。
- 命令、报告、批准由宿主上下文和持久化状态验证，不采信模型自报。

## 实施任务

| ID | 依赖 | 内容 |
|---|---|---|
| T01 | 无 | 包、TypeScript、测试、最小 V2 插件与宿主验证夹具 |
| T02 | T01 | 路径、工作区、受限产物 IO |
| T03 | T02 | spec 解析、严格校验、DAG |
| T04 | T02 | run 状态机、锁、存储适配 |
| T05 | T01,T02 | profile、绑定、权限守卫 |
| T06 | T03-T05 | 角色运行器、报告、预算 |
| T07 | T03-T05 | 验收执行器、证据、工作区指纹 |
| T08 | T06,T07 | Plan 命令与技能 |
| T09 | T06-T08 | Exec 命令与技能 |
| T10 | T09 | status、错误码、最终报告 |
| T11 | T09,T10 | 事件、恢复、清理 |
| T12 | T09,T11 | F 有限并行 |
| T13 | T09,T11 | worktree 适配 |
| T14 | T05,T10 | init/doctor/uninstall CLI |
| T15 | T08-T14 | 文档、许可证、打包 |
| T16 | 全部 | 宿主端到端、CI、安装验收 |

## 推荐顺序

```text
T01 → T02 → T03/T04/T05 → T06/T07 → T08 → T09 → T10 → T11 → T12/T13 → T14 → T15 → T16
```

## 测试层次

- 单元测试：解析、DAG、状态迁移、预算、绑定、路径。
- 集成测试：文件系统、Git、锁竞争、命令成功/失败/超时/取消、dirty worktree、代码漂移。
- 宿主测试：隔离服务路径，使用 @opencode/client@2.2.5。
- 真实模型 smoke 单独显式执行，不混入普通测试。

## 完成标准

- [ ] 三个命令在 V2.2.5 可用。
- [ ] 已确认角色和预算实现。
- [ ] 默认不强制委托实现。
- [ ] spec/run/evidence/approval 分离。
- [ ] D 不通过不能执行；G/H 不通过不能成功。
- [ ] 暂停、阻塞、过期、成功严格区分。
- [ ] 恢复、并发、dirty worktree、取消测试通过。
- [ ] F 与 worktree 是可用功能。
- [ ] 无自动发布/合并/覆盖用户修改。
- [ ] 从打包产物完成端到端验收。
- [ ] 文档说明权限和边界。

## 当前进度

- [x] 保存实施计划
- [x] T01 包、构建、测试与真实 V2 宿主验证
- [x] T02 路径、工作区、受限产物 IO
- [x] T03 spec 解析、严格校验、DAG
- [x] T04 run 状态机、工作区锁、存储
- [x] T05 五个 profile、角色绑定、权限守卫
- [x] T06 角色运行器、结构化报告、预算
- [x] T07 验收执行器、证据、代码指纹
- [x] T08 Plan 命令与技能
- [x] T09 Exec 命令与技能（默认直接实施）
- [x] T10 status、错误码、最终报告
- [x] T11 恢复与清理（采用 session 状态轮询；未依赖实验性 wait/event）
- [x] T12 F worker 可选并行调用与范围守卫
- [x] T13 原生 worktree 适配（auto/explicit，spec 复制，运行目录解析）
- [x] T14 init/doctor/uninstall CLI
- [x] T15 README、LICENSE、NOTICE、打包
- [x] T16 隔离宿主测试、CI 命令、打包验收

## 验证记录（当前工作树）

```text
npm run typecheck                 ok
npm run lint                      ok
npm run test:unit                 25 tests pass
npm run test:integration          10 tests pass
npm run test:host                 1 isolated OpenCode 2.2.5 host test pass
npm pack --dry-run                package contents verified
```

真实模型 smoke：

- 2026-11-06：`practical-reviewer` 在 `role-smoke` 上返回绑定报告并批准；随后 `ulw_spec publish` 成功。
- 2026-11-06：`explorer` 在 `role-smoke` 上返回绑定报告（约 20 秒），验证 session 状态轮询等待。
- 2026-11-06：从 `npm pack` tarball 安装到隔离项目后，服务可加载 `ulw-plan`/`ulw-execute`/`ulw-status`、五个角色和两个技能。
- 完整 Plan → Execute → G/H 的真实模型流程仍需在操作者配置的 provider 上做一次显式 smoke；自动化状态机已由 integration test 覆盖。

