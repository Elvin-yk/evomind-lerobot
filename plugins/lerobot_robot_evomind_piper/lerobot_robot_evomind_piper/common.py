"""Shared PiperX SDK helpers.

The hardware protocol follows Evo-RL's LeRobot implementation while keeping the
stable USB-CAN identity and firmware gate used by EvoStudio Client.
"""

from __future__ import annotations

import math
import re
import subprocess
import time
from functools import lru_cache
from pathlib import Path
from typing import Any

PIPER_JOINT_NAMES = tuple(f"joint_{index}" for index in range(1, 7))
PIPER_JOINT_KEYS = tuple(f"{name}.pos" for name in PIPER_JOINT_NAMES)
PIPER_ACTION_KEYS = PIPER_JOINT_KEYS + ("gripper.pos",)
PIPER_ROLE_LEADER = 0xFA
PIPER_ROLE_FOLLOWER = 0xFC
MINIMUM_FIRMWARE = (1, 8, 9)
JOINT_LIMITS_DEGREES = {
    "joint_1.pos": (-150.0, 150.0),
    "joint_2.pos": (0.0, 180.0),
    "joint_3.pos": (-154.5, 0.0),
    "joint_4.pos": (-105.0, 105.0),
    "joint_5.pos": (-70.0, 70.0),
    "joint_6.pos": (-180.0, 180.0),
}
MAX_GRIPPER_POSITION = 100.0


def resolve_can_interface(serial_number: str) -> str:
    """Resolve an ID_SERIAL_SHORT value to its current SocketCAN interface."""
    for interface_path in sorted(Path("/sys/class/net").iterdir()):
        try:
            if (interface_path / "type").read_text().strip() != "280":
                continue
        except OSError:
            continue
        result = subprocess.run(
            ["udevadm", "info", "--query=property", f"--path={interface_path}"],
            capture_output=True,
            text=True,
            check=False,
        )
        if f"ID_SERIAL_SHORT={serial_number}" in result.stdout.splitlines():
            return interface_path.name
    raise RuntimeError(f"未找到 USB-CAN 适配器：{serial_number}")


@lru_cache(maxsize=1)
def sdk_types() -> tuple[type[Any], Any]:
    try:
        from piper_sdk import C_PiperInterface_V2, LogLevel
    except ModuleNotFoundError as error:
        raise ModuleNotFoundError("PiperX 需要安装 piper_sdk>=0.6.1,<0.7.0") from error
    return C_PiperInterface_V2, LogLevel


def create_sdk(serial_number: str, log_level: str = "WARNING") -> Any:
    interface_class, log_levels = sdk_types()
    try:
        selected_level = getattr(log_levels, log_level.upper())
    except AttributeError as error:
        raise ValueError(f"无效的 Piper SDK 日志级别：{log_level}") from error
    return interface_class(
        can_name=resolve_can_interface(serial_number),
        judge_flag=False,
        can_auto_init=True,
        logger_level=selected_level,
    )


def require_firmware(arm: Any, timeout_s: float = 3.0) -> str:
    arm.SearchPiperFirmwareVersion()
    deadline = time.monotonic() + timeout_s
    while time.monotonic() < deadline:
        value = arm.GetPiperFirmwareVersion()
        if isinstance(value, str):
            match = re.search(r"S-V(\d+)\.(\d+)-(\d+)", value)
            if not match:
                raise RuntimeError(f"无法解析 PiperX 固件版本：{value}")
            version = tuple(int(part) for part in match.groups())
            if version < MINIMUM_FIRMWARE:
                raise RuntimeError(f"PiperX 固件 {value} 低于最低要求 S-V1.8-9")
            return value
        time.sleep(0.1)
    raise RuntimeError("读取 PiperX 固件版本超时")


def wait_enabled(arm: Any, timeout_s: float) -> None:
    deadline = time.monotonic() + timeout_s
    while time.monotonic() < deadline:
        if bool(arm.EnablePiper()):
            return
        time.sleep(0.2)
    raise RuntimeError("PiperX 电机未在规定时间内完成使能")


def set_role(arm: Any, role: int) -> None:
    arm.MasterSlaveConfig(role, 0x00, 0x00, 0x00)


def verify_follower_role(arm: Any, previous_control_timestamp: float) -> None:
    """Require a quiet operator-control bus after switching to follower role."""
    deadline = time.monotonic() + 1.0
    quiet_since = time.monotonic()
    last_timestamp = previous_control_timestamp
    while time.monotonic() < deadline:
        timestamp = arm.GetArmJointCtrl().time_stamp
        if timestamp > last_timestamp:
            last_timestamp = timestamp
            quiet_since = time.monotonic()
        if time.monotonic() - quiet_since >= 0.1:
            return
        time.sleep(0.01)
    raise RuntimeError("PiperX 切换从臂模式后仍在发送主臂控制帧")


def milli_to_unit(value: float | int) -> float:
    return float(value) * 1e-3


def unit_to_milli(value: float | int) -> int:
    return int(round(float(value) * 1e3))


def validate_action(action: dict[str, Any]) -> dict[str, float]:
    missing = [key for key in PIPER_ACTION_KEYS if key not in action]
    if missing:
        raise ValueError(f"PiperX 动作缺少字段：{', '.join(missing)}")
    values = {key: float(action[key]) for key in PIPER_ACTION_KEYS}
    if not all(math.isfinite(value) for value in values.values()):
        raise ValueError("PiperX 动作包含非有限值")
    for key, (minimum, maximum) in JOINT_LIMITS_DEGREES.items():
        if not minimum <= values[key] <= maximum:
            raise ValueError(f"PiperX 关节目标超出允许范围：{key}={values[key]:.3f}")
    if not 0 <= values["gripper.pos"] <= MAX_GRIPPER_POSITION:
        raise ValueError(f"PiperX 夹爪目标超出允许范围：{values['gripper.pos']:.3f}")
    return values


def clip_relative_action(
    requested: dict[str, float],
    current: dict[str, float],
    joint_limit: float,
    gripper_limit: float,
) -> dict[str, float]:
    limits = {**dict.fromkeys(PIPER_JOINT_KEYS, joint_limit), "gripper.pos": gripper_limit}
    return {
        key: max(current[key] - limits[key], min(current[key] + limits[key], requested[key]))
        for key in PIPER_ACTION_KEYS
    }


def read_feedback(arm: Any) -> dict[str, float] | None:
    joint_message = arm.GetArmJointMsgs()
    gripper_message = arm.GetArmGripperMsgs()
    if joint_message.time_stamp <= 0 or gripper_message.time_stamp <= 0:
        return None
    joints = joint_message.joint_state
    action = {f"{name}.pos": milli_to_unit(getattr(joints, name)) for name in PIPER_JOINT_NAMES}
    action["gripper.pos"] = abs(milli_to_unit(gripper_message.gripper_state.grippers_angle))
    return validate_action(action)


def wait_feedback(arm: Any, timeout_s: float, *, after_joint_timestamp: float = 0.0) -> dict[str, float]:
    deadline = time.monotonic() + timeout_s
    while time.monotonic() < deadline:
        if arm.GetArmJointMsgs().time_stamp <= after_joint_timestamp:
            time.sleep(0.01)
            continue
        action = read_feedback(arm)
        if action is not None:
            return action
        time.sleep(0.01)
    raise RuntimeError("未收到完整的 PiperX 关节与夹爪反馈")


def send_action(arm: Any, action: dict[str, float], effort: int) -> None:
    arm.JointCtrl(*(unit_to_milli(action[key]) for key in PIPER_JOINT_KEYS))
    arm.GripperCtrl(unit_to_milli(action["gripper.pos"]), effort, 0x01, 0x00)
