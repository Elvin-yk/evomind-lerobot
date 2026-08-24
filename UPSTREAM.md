# LeRobot 上游跟进记录

本文件记录 EvoStudio Runtime 当前基于哪个 LeRobot 版本、哪些上游核心文件被有意修改，以及升级时必须执行的步骤。每次合并新的 LeRobot Tag，都必须在同一个合并请求中更新本文件。

## 当前基线

| 项目         | 当前值                                       |
| ------------ | -------------------------------------------- |
| 上游仓库     | `https://github.com/huggingface/lerobot.git` |
| 上游 Tag     | `v0.6.1`                                     |
| 上游提交     | `7e241bd630a3719a56157a497ce5d08f244784f1`   |
| 基线确认日期 | `2026-08-24`                                 |
| Python 要求  | `>=3.12`                                     |

## Git LFS 策略

EvoStudio Runtime 不使用 Git LFS。极狐Lab项目已关闭 LFS，当前主线删除官方 `tests/artifacts/` 中的 LFS 测试资源，并移除 `.gitattributes` 中的 LFS 规则。

为了保持与 LeRobot 官方 Tag 的共同祖先，历史提交中的 pointer 文本不做全历史重写，但对应 LFS 实体不上传到极狐Lab。升级合并新的官方 Tag 后，必须在同一升级分支删除新引入的 LFS 文件和规则。依赖这些资源的上游测试不能作为本仓库默认检查；确有需要时应从官方或专用测试存储临时下载。

## Remote 约定

```text
origin    极狐Lab evomind/evostudio-runtime，唯一推送目标
upstream  Hugging Face LeRobot，只读更新来源
```

禁止向 `upstream` 推送，禁止触发 GitHub Actions。建议在本地禁用该 remote 的 push URL：

```bash
git remote set-url --push upstream no_push
```

## LeRobot 核心差异清单

这里的“核心差异”是指相对当前官方 Tag 对 `src/lerobot/` 的修改。产品目录、设备扩展目录和文档不登记在此表。

| 文件 | 修改原因                          | 默认行为是否变化 | 验证方式                              |
| ---- | --------------------------------- | ---------------- | ------------------------------------- |
| 无   | 初始化阶段尚未修改 `src/lerobot/` | 否               | `git diff v0.6.1 -- src/lerobot` 为空 |

没有登记的 `src/lerobot/` 差异视为错误，不允许发布。

## 升级到新的稳定 Tag

### 1. 获取并确认上游版本

```bash
git fetch upstream main --tags
git tag --list 'v*' --sort=-version:refname
git show --no-patch --decorate <new-tag>
```

只升级到经过确认的官方稳定 Tag。不要把 `upstream/main` 的任意提交直接作为生产基线。

### 2. 创建独立升级分支

```bash
git switch main
git pull --ff-only origin main
git switch -c upgrade/lerobot-<new-tag>
```

升级分支只处理上游合并、冲突和兼容修复，不同时开发新的 EvoStudio 功能。

### 3. 合并官方 Tag

```bash
git merge --no-ff <new-tag>
```

不要使用 squash 合并上游，也不要复制新版本源码覆盖当前目录。保留官方提交历史，后续才能准确定位冲突和回归。

### 4. 审计核心差异

```bash
git diff <new-tag> -- src/lerobot
git diff --stat <new-tag>
```

逐项核对本文件中的核心差异清单：

- Hook 是否仍然需要。
- 上游是否已经提供等价公开接口。
- 函数签名、状态转换和生命周期是否发生变化。
- 能否删除现有补丁并直接采用上游实现。

如果上游已经实现等价能力，应删除自有补丁，不保留兼容包装层。

### 5. 更新依赖与文档

- 按上游提交更新并重新锁定依赖。
- 更新本文件中的 Tag、提交、日期、Python 要求和核心差异表。
- 更新 README 中的当前基线和版本链接。
- 检查安装器涉及的系统依赖、ROS、CUDA、FFmpeg、相机和机器人 SDK 是否变化。
- 删除新版本重新带入的 LFS 文件和 `.gitattributes` LFS 规则，不得上传 LFS 对象。

### 6. 分级验证

首先运行受影响的现有检查：

```bash
uv sync --locked --extra test --extra dev
uv run pre-commit run --all-files
uv run pytest <受影响的现有测试>
```

然后进行 Runtime 兼容验证：

- Studio 任务能够启动、停止并报告失败。
- 官方 teleoperate、record 和所使用的 rollout strategy 行为正常。
- 结构化事件顺序完整，重连后能够恢复状态快照。
- LeRobotDataset 可以保存、读取和上传，数据结构与官方兼容。
- 未配置 EvoStudio Hook 时，官方 CLI 和日志行为不变。

发布前对每个声明支持的本体执行真机验证。没有硬件验证结果时，可以完成升级开发，但不能发布为受支持版本。

### 7. 合并与发布

升级验证完成后合并到极狐Lab `main`。没有每日或每周上游同步任务；只在团队决定升级时执行本流程，并按需要手动运行一次发布流水线。

## 提交分层建议

升级过程尽量保持以下提交顺序：

1. `upstream: merge LeRobot vX.Y.Z`
2. `hook: adapt <generic hook> to LeRobot vX.Y.Z`
3. `evostudio: adapt runtime integration to LeRobot vX.Y.Z`
4. `docs: record LeRobot vX.Y.Z upgrade`

这样发生问题时，可以单独审查、回退或向上游提交通用补丁，而不必从产品代码中拆解差异。
