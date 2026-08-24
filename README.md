# EvoStudio Runtime

EvoStudio Runtime 是 EvoStudio 在机器人端运行的数据采集、遥操作、策略 rollout 和设备接入运行时。本仓库直接基于 Hugging Face LeRobot，并以“可持续跟进上游的薄 Fork”方式维护。

> 当前状态：仓库初始化阶段。`main` 基于 LeRobot `v0.6.1`（`7e241bd630a3719a56157a497ce5d08f244784f1`）。新的 Runtime 尚未替代现有 `evostudio-client`；完成真机验证和迁移验收之前，现有 Client 继续承担生产工作。

## 背景

EvoStudio 需要同时满足以下要求：

- 使用 LeRobot 原生的 Dataset、rollout、策略推理和日志行为，避免重复实现后逐渐偏离官方。
- 支持 PiperX、双臂 PiperX、SO101e，以及未来新增的机器人本体和遥操作设备。
- 由 Studio 统一安排采集任务、人员和设备，并把运行过程中的结构化状态实时传回前端。
- 保留必要的定制能力，包括设备接入、运行事件、安全控制和安装环境集成。
- 能较快合并 LeRobot 后续版本，而不是长期停留在一个固定版本。
- 对外保持单一产品、单一仓库和统一安装入口。

此前的 `evostudio-app` 与 `evostudio-engine` 将 Studio 服务和 LeRobot Fork 分成两个仓库，并通过依赖重定向组合；现有 Rust `evostudio-client` 又重新实现了部分 LeRobot 采集能力。两种方式都增加了重复维护或版本跟进成本。

本仓库采用不同边界：**直接保留 LeRobot 的完整 Git 历史，在同一个仓库内维护少量通用 Hook 和隔离的 EvoStudio 功能。** 我们允许修改 LeRobot，但必须让修改范围小、目的清楚、升级时容易审计。

## 设计原则

1. **LeRobot 原生能力优先**

   Dataset、rollout strategy、policy、robot abstraction、teleoperation 和日志均优先使用官方实现。已有能力不得在 EvoStudio 中复制一套。

2. **一个仓库，不再拆 Engine**

   EvoStudio 接口、设备实现和必要的 LeRobot 修改都在本仓库维护。不再通过另一个仓库重定向 `lerobot` 依赖，也不把 ROS 或第三方 SDK 源码复制进来。

3. **自有代码与上游代码隔离**

   产品逻辑应进入 EvoStudio 自有命名空间。只有无法通过公开接口完成、且确实属于通用运行能力的 Hook 才允许修改 `src/lerobot/`。

4. **事件是接口，日志不是接口**

   Studio 所需状态必须通过结构化事件产生，不得通过解析 stdout/stderr 猜测。官方日志原样保留，事件单独传输。

5. **硬件只有一个所有者**

   rollout 或采集运行时由 LeRobot 进程独占机器人和摄像头。Studio 服务只负责下发任务、监督进程和转发事件，不得同时打开同一硬件。

6. **默认保持 LeRobot 数据兼容**

   默认使用官方 LeRobotDataset schema。只有明确的数据产品需求才能增加字段，并且必须说明训练、上传和版本兼容影响。

7. **升级按需执行，不做周期性 CI**

   不设置每日或每周兼容性流水线。只在主动升级 LeRobot 或发布 EvoStudio Runtime 时运行相应检查，避免无意义消耗极狐Lab CI 额度。

8. **仓库不使用 Git LFS**

   极狐Lab项目关闭 Git LFS，官方 `tests/artifacts/` 中由 LFS 管理的测试数据不进入 EvoStudio Runtime 主线。历史提交里的 LFS pointer 仅用于保留上游 Git 血缘，不上传对应实体。需要测试数据时应由测试脚本从明确的数据源按需下载，不得重新提交 LFS 对象。

## 目标代码边界

以下是实现阶段应遵守的目标结构；初始化阶段部分目录尚未创建：

```text
src/
├── lerobot/                       # 官方 LeRobot；原则上保持原样
├── evostudio_runtime/             # Studio 协议、任务监督、事件、安装集成
├── lerobot_robot_evostudio/       # PiperX、双臂及未来机器人实现
└── lerobot_teleoperator_evostudio/ # 自有遥操作设备实现
```

- `src/evostudio_runtime/` 可以依赖 LeRobot。
- `src/lerobot/` 不得反向依赖具体的 Studio 云端 API、页面模型或业务对象。
- 如果必须修改 `src/lerobot/`，优先加入不包含 EvoStudio 业务语义的通用 Hook，例如 `event_sink`。
- 新机器人应遵循 LeRobot 的 Robot/Teleoperator 扩展接口，不应把本体判断散落在采集流程中。

## 运行事件边界

完整状态不能只用一个字符串表达。例如 Sentry 可以一边自动运行、一边后台上传。事件至少按以下独立领域建模：

- `runtime`：准备、连接、就绪、运行、停止、完成、失败。
- `control`：遥操作、自动策略、暂停、人工修正、复位、安全保持。
- `episode`：空闲、缓冲、录制、保存、已保存、丢弃。
- `upload`：空闲、上传中、完成、失败。

每个事件必须包含运行标识、单调递增序号、时间戳、领域、前后状态和完整快照。这样前端可以检测丢包，并在重连后恢复当前状态。具体协议在实现前单独评审；不要先为某一种 rollout strategy 写私有状态格式。

## 开发准则

首次拉取仓库后，配置只读上游并安装基础开发环境：

```bash
git clone https://jihulab.com/evomind/evostudio-runtime.git
cd evostudio-runtime
git remote add upstream https://github.com/huggingface/lerobot.git
git remote set-url --push upstream no_push
git fetch upstream main --tags
uv sync --locked --extra test --extra dev
```

### 开始修改前

1. 阅读本 README、[`UPSTREAM.md`](./UPSTREAM.md) 和 [`AGENTS.md`](./AGENTS.md)。
2. 在 LeRobot 中搜索是否已有对应能力或扩展点。
3. 判断改动属于：上游通用修复、通用 Hook、EvoStudio 产品逻辑或设备实现。
4. 只有通用修复或通用 Hook 可以进入 `src/lerobot/`。

### 提交要求

- 不直接在 `main` 开发；每个功能或升级使用独立分支。
- 一个提交只表达一个清晰意图，避免把上游合并、格式化和 EvoStudio 功能混在一起。
- 修改 `src/lerobot/` 的提交必须能单独阅读，并说明为什么公开扩展接口不足。
- 不进行无关的大范围重命名、格式化或目录移动，避免人为制造上游冲突。
- 不保留已经废弃的接口、兼容包装层或静默 fallback；迁移完成后直接删除旧路径。
- 不捕获并吞掉宽泛异常。错误必须进入明确的失败状态并保留原始原因。
- 不添加 Git LFS 规则或 LFS 文件；升级带入的 LFS 测试资源必须在升级分支中删除。

推荐将提交保持为三类清晰层次：

```text
upstream: merge LeRobot vX.Y.Z
hook: add generic rollout event sink
evostudio: relay runtime events to Studio
```

### 修改 LeRobot 核心时

必须同时满足：

- 改动确实无法放入 `evostudio_runtime` 或设备扩展模块。
- Hook 使用通用术语，不直接引用 EvoStudio Cloud、Web 或具体本体。
- 默认未配置 Hook 时，官方行为、CLI 参数、日志和数据结果不变。
- 在 [`UPSTREAM.md`](./UPSTREAM.md) 的核心差异表中登记文件、原因和验证方式。
- 优先形成可以向 LeRobot 官方贡献的独立补丁。

### 验证原则

根据改动范围做最小但充分的验证：

```bash
uv sync --locked --extra test --extra dev
uv run pre-commit run --all-files
uv run pytest <受影响的现有测试>
```

仓库初始化阶段不主动增加新测试。实现开始后，先使用 LeRobot 已有测试；只有新协议或新设备确实没有覆盖时，再随功能设计对应验证方案。涉及采集、遥操、相机或真实动作的发布必须做真机验证，不能只依赖 Mock。

## 跟进 LeRobot 上游

Git remote 约定：

```text
origin    https://jihulab.com/evomind/evostudio-runtime.git
upstream  https://github.com/huggingface/lerobot.git
```

`origin` 是唯一推送目标；`upstream` 只读，禁止向 GitHub 推送或触发 GitHub Actions。升级操作的完整步骤见 [`UPSTREAM.md`](./UPSTREAM.md)。核心流程是：

1. 确认新的官方稳定 Tag，而不是直接追随每天变化的 `upstream/main`。
2. 从当前 `main` 创建 `upgrade/lerobot-vX.Y.Z` 分支。
3. 合并新的官方 Tag，单独解决冲突，不顺便增加产品功能。
4. 审计 `src/lerobot/` 中仍然存在的自有差异。
5. 运行针对性软件检查和升级兼容检查。
6. 完成支持本体的真机验证后，才允许发布。

## 迁移计划

在新 Runtime 完成前，现有 `evostudio-client` 保持生产可用，不能为了迁移提前破坏其安装或更新流程。

迁移按以下顺序推进：

1. 定义 Studio 与 Runtime 的任务协议和结构化事件协议。
2. 接入 LeRobot 原生遥操、record 和 rollout，不修改数据语义。
3. 接入 PiperX、双臂 PiperX、SO101e，并统一设备配置。
4. 对比新旧 Client 的安装、设备发现、采集、上传和异常恢复。
5. 完成真机验收后再切换 Studio 默认入口。
6. 为旧 Client 保留最终 Tag 和只读分支，然后停止双线开发。

## 当前基线与许可证

- 上游项目：[huggingface/lerobot](https://github.com/huggingface/lerobot)
- 当前基线：[LeRobot v0.6.1](https://github.com/huggingface/lerobot/tree/v0.6.1)
- 基线提交：`7e241bd630a3719a56157a497ce5d08f244784f1`
- 许可证：Apache License 2.0，见 [`LICENSE`](./LICENSE)

本仓库不是 Hugging Face 官方发行版。使用 LeRobot 的文档、引用方式和完整功能说明请查看对应版本的[官方 README](https://github.com/huggingface/lerobot/blob/v0.6.1/README.md)。
