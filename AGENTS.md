# EvoStudio Runtime 开发准则

## 定位

本仓库是 LeRobot 的独立薄 Fork，负责机器人接入、遥操、数据采集、policy rollout 和通用运行事件。

- 不接入 EvoStudio Cloud、Web、Client 或 umbrella。
- 不拆分新的 Engine 仓库，不重定向到其他 LeRobot 源码。
- 优先使用 LeRobot 原生 Dataset、record、rollout、policy 和日志，不重复实现。

## 代码边界

```text
src/lerobot/                        官方 LeRobot 代码
src/evostudio_runtime/              Runtime CLI、生命周期和通用事件
src/lerobot_robot_evostudio/        自有机器人实现
src/lerobot_teleoperator_evostudio/ 自有遥操作设备实现
```

- 自有功能放在自有目录。
- 只有公开扩展点无法满足的通用 Hook，才能修改 `src/lerobot/`。
- Hook 未启用时，官方 CLI、日志、数据和运行行为必须保持不变。
- `src/lerobot/` 不得依赖任何 EvoStudio 业务或具体机器人。

## 开发规则

- 修改前先确认 LeRobot 是否已有对应能力。
- 状态通过结构化事件输出，禁止解析日志判断状态。
- Runtime 运行时独占机器人和摄像头，外部调用方不得重复打开硬件。
- 默认保持官方 LeRobotDataset schema。
- 不添加兼容包装、静默 fallback 或宽泛异常捕获。
- 不做无关重构、全局格式化或大范围目录调整。
- 一个提交只做一件事；上游合并、核心 Hook 和 Runtime 功能分开提交。
- Git LFS 已关闭。不得添加 LFS 规则或对象；升级带入的 LFS 测试资源直接删除。
- 不设置每日或每周 CI，只在主动升级或发布时运行检查。
- 涉及真实硬件的发布必须完成对应本体的真机验证。

## 上游基线

- Tag：`v0.6.1`
- Commit：`7e241bd630a3719a56157a497ce5d08f244784f1`
- `origin`：极狐Lab，唯一推送目标。
- `upstream`：`https://github.com/huggingface/lerobot.git`，只读，禁止推送或触发 GitHub Actions。

当前 `src/lerobot/` 相对基线没有差异。以后每个核心修改都必须在下表登记：

| 文件 | 原因                  | 验证方式                              |
| ---- | --------------------- | ------------------------------------- |
| 无   | 尚未修改 LeRobot 核心 | `git diff v0.6.1 -- src/lerobot` 为空 |

## 升级 LeRobot

只跟进官方稳定 Tag，不持续追随 `upstream/main`：

```bash
git fetch upstream main --tags
git switch -c upgrade/lerobot-vX.Y.Z main
git merge --no-ff vX.Y.Z
git diff vX.Y.Z -- src/lerobot
```

升级时必须：

1. 单独解决上游冲突，不同时开发新功能。
2. 删除新引入的 LFS 文件和规则。
3. 检查已有核心 Hook 是否已被官方能力替代，能删除就删除。
4. 更新本文件中的基线和核心差异表。
5. 运行受影响的现有测试，并在发布前完成真机验证。
