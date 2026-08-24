# Evomind LeRobot 开发准则

## 目标

本仓库是 LeRobot 的薄 Fork，主要用于机器人遥操、数据采集和 policy rollout，也可以提供 API 和结构化事件给本地网站使用。

- 优先使用 LeRobot 原生 Dataset、record、rollout、policy 和日志。
- 支持自有机器人和遥操作设备。
- 核心改动保持最少，方便持续合并官方版本。

## 代码边界

```text
src/lerobot/                        官方 LeRobot 代码
src/evomind_lerobot/                本地 CLI、API 和通用事件
src/lerobot_robot_evomind/          自有机器人实现
src/lerobot_teleoperator_evomind/   自有遥操作设备实现
```

- 自有功能放在自有目录。
- 只有公开扩展点无法满足的通用 Hook，才能修改 `src/lerobot/`。
- Hook 未启用时，官方 CLI、日志、数据和行为必须保持不变。
- 新机器人通过 LeRobot 的 Robot/Teleoperator 接口接入，不把本体判断散落到采集流程。

## 开发规则

- 修改前先确认 LeRobot 是否已有对应能力，不重复实现。
- 状态通过结构化事件输出，禁止解析日志判断状态。
- 运行时独占机器人和摄像头，调用方不得重复打开硬件。
- 默认保持官方 LeRobotDataset schema。
- 不添加兼容包装、静默 fallback 或宽泛异常捕获。
- 不做无关重构或全局格式化。
- 上游合并、核心 Hook 和自有功能分开提交。
- Git LFS 已关闭；不得添加 LFS 对象，升级带入的 LFS 测试资源直接删除。
- 不设置周期性 CI，只在升级或发布时运行检查。
- 涉及真实硬件的发布必须完成真机验证。

## 上游基线

- Tag：`v0.6.1`
- Commit：`7e241bd630a3719a56157a497ce5d08f244784f1`
- `origin`：极狐Lab，唯一推送目标。
- `upstream`：`https://github.com/huggingface/lerobot.git`，只读。

当前 `src/lerobot/` 相对基线没有差异。以后每个核心修改都必须在下表登记：

| 文件 | 原因                  | 验证方式                              |
| ---- | --------------------- | ------------------------------------- |
| 无   | 尚未修改 LeRobot 核心 | `git diff v0.6.1 -- src/lerobot` 为空 |

## 升级 LeRobot

只跟进官方稳定 Tag：

```bash
git fetch upstream main --tags
git switch -c upgrade/lerobot-vX.Y.Z main
git merge --no-ff vX.Y.Z
git diff vX.Y.Z -- src/lerobot
```

升级时只处理冲突和兼容问题；删除新引入的 LFS 文件，更新上游基线和核心差异，并在发布前完成相关测试与真机验证。
