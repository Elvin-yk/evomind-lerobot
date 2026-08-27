"""LeRobot PiperX robot and teleoperator implementations."""

from __future__ import annotations

import multiprocessing as mp
import time
import traceback
from contextlib import suppress
from dataclasses import dataclass, field
from functools import cached_property
from typing import Any

from lerobot.cameras import CameraConfig, make_cameras_from_configs
from lerobot.lerobot_types import RobotAction, RobotObservation
from lerobot.robots.config import RobotConfig
from lerobot.robots.robot import Robot
from lerobot.teleoperators.config import TeleoperatorConfig
from lerobot.teleoperators.teleoperator import Teleoperator
from lerobot.utils.decorators import check_if_already_connected, check_if_not_connected

from .common import (
    PIPER_ACTION_KEYS,
    PIPER_JOINT_KEYS,
    PIPER_ROLE_FOLLOWER,
    PIPER_ROLE_LEADER,
    clip_relative_action,
    create_sdk,
    require_firmware,
    send_action,
    set_role,
    validate_action,
    verify_follower_role,
    wait_enabled,
    wait_feedback,
)


@RobotConfig.register_subclass("piperx_follower")
@dataclass(kw_only=True)
class PiperXFollowerConfig(RobotConfig):
    port: str
    cameras: dict[str, CameraConfig] = field(default_factory=dict)
    speed_ratio: int = 10
    gripper_effort: int = 1000
    max_relative_joint_target: float = 3.0
    max_relative_gripper_target: float = 10.0
    connect_timeout_s: float = 3.0
    log_level: str = "WARNING"

    def __post_init__(self) -> None:
        super().__post_init__()
        if not 1 <= self.speed_ratio <= 100:
            raise ValueError("speed_ratio 必须在 1 到 100 之间")
        if not 0 <= self.gripper_effort <= 5000:
            raise ValueError("gripper_effort 必须在 0 到 5000 之间")


@TeleoperatorConfig.register_subclass("piperx_leader")
@dataclass(kw_only=True)
class PiperXLeaderConfig(TeleoperatorConfig):
    port: str
    connect_timeout_s: float = 3.0
    log_level: str = "WARNING"


@RobotConfig.register_subclass("bi_piperx_follower")
@dataclass(kw_only=True)
class BiPiperXFollowerConfig(RobotConfig):
    left_arm_config: PiperXFollowerConfig
    right_arm_config: PiperXFollowerConfig
    cameras: dict[str, CameraConfig] = field(default_factory=dict)
    process_isolation: bool = True

    def __post_init__(self) -> None:
        super().__post_init__()
        if self.left_arm_config.port == self.right_arm_config.port:
            raise ValueError("左右 PiperX 从臂必须使用不同的 USB-CAN 适配器")


@TeleoperatorConfig.register_subclass("bi_piperx_leader")
@dataclass(kw_only=True)
class BiPiperXLeaderConfig(TeleoperatorConfig):
    left_arm_config: PiperXLeaderConfig
    right_arm_config: PiperXLeaderConfig
    process_isolation: bool = True

    def __post_init__(self) -> None:
        if self.left_arm_config.port == self.right_arm_config.port:
            raise ValueError("左右 PiperX 主臂必须使用不同的 USB-CAN 适配器")


class PiperXFollower(Robot):
    config_class = PiperXFollowerConfig
    name = "piperx_follower"

    def __init__(self, config: PiperXFollowerConfig):
        super().__init__(config)
        self.config = config
        self.arm = create_sdk(config.port, config.log_level)
        self.cameras = make_cameras_from_configs(config.cameras)
        self._is_connected = False
        self._last_action: dict[str, float] | None = None

    @cached_property
    def observation_features(self) -> dict[str, type | tuple]:
        cameras = {key: (config.height, config.width, 3) for key, config in self.config.cameras.items()}
        return {**dict.fromkeys(PIPER_ACTION_KEYS, float), **cameras}

    @cached_property
    def action_features(self) -> dict[str, type]:
        return dict.fromkeys(PIPER_ACTION_KEYS, float)

    @property
    def is_connected(self) -> bool:
        return self._is_connected and all(camera.is_connected for camera in self.cameras.values())

    @check_if_already_connected
    def connect(self, calibrate: bool = True) -> None:
        del calibrate
        connected_cameras = []
        self.arm.ConnectPort(can_init=True)
        try:
            require_firmware(self.arm, self.config.connect_timeout_s)
            control_timestamp = self.arm.GetArmJointCtrl().time_stamp
            feedback_timestamp = self.arm.GetArmJointMsgs().time_stamp
            set_role(self.arm, PIPER_ROLE_FOLLOWER)
            verify_follower_role(self.arm, control_timestamp)
            self.arm.MotionCtrl_2(0x01, 0x01, self.config.speed_ratio, 0xAD)
            wait_enabled(self.arm, self.config.connect_timeout_s)
            self._last_action = wait_feedback(
                self.arm,
                self.config.connect_timeout_s,
                after_joint_timestamp=feedback_timestamp,
            )
            for camera in self.cameras.values():
                camera.connect()
                connected_cameras.append(camera)
            self._is_connected = True
        except Exception:
            for camera in connected_cameras:
                camera.disconnect()
            self.arm.DisconnectPort()
            self._last_action = None
            raise

    @property
    def is_calibrated(self) -> bool:
        return True

    def calibrate(self) -> None:
        return None

    def configure(self) -> None:
        if not self._is_connected:
            raise ConnectionError(f"{self} 尚未连接")
        set_role(self.arm, PIPER_ROLE_FOLLOWER)
        self.arm.MotionCtrl_2(0x01, 0x01, self.config.speed_ratio, 0xAD)

    @check_if_not_connected
    def get_observation(self) -> RobotObservation:
        observation = wait_feedback(self.arm, self.config.connect_timeout_s)
        for key, camera in self.cameras.items():
            observation[key] = camera.async_read()
        return observation

    @check_if_not_connected
    def send_action(self, action: RobotAction) -> RobotAction:
        requested = validate_action(action)
        current = self._last_action or wait_feedback(self.arm, self.config.connect_timeout_s)
        safe_action = clip_relative_action(
            requested,
            current,
            self.config.max_relative_joint_target,
            self.config.max_relative_gripper_target,
        )
        send_action(self.arm, safe_action, self.config.gripper_effort)
        self._last_action = safe_action
        return safe_action

    @check_if_not_connected
    def disconnect(self) -> None:
        try:
            for camera in self.cameras.values():
                camera.disconnect()
        finally:
            self.arm.DisconnectPort()
            self._is_connected = False
            self._last_action = None


class PiperXLeader(Teleoperator):
    config_class = PiperXLeaderConfig
    name = "piperx_leader"

    def __init__(self, config: PiperXLeaderConfig):
        super().__init__(config)
        self.config = config
        self.arm = create_sdk(config.port, config.log_level)
        self._is_connected = False
        self._last_action: dict[str, float] | None = None
        self._joint_timestamp = 0.0
        self._gripper_timestamp = 0.0

    @cached_property
    def action_features(self) -> dict[str, type]:
        return dict.fromkeys(PIPER_ACTION_KEYS, float)

    @cached_property
    def feedback_features(self) -> dict[str, type]:
        return {}

    @property
    def is_connected(self) -> bool:
        return self._is_connected

    @check_if_already_connected
    def connect(self, calibrate: bool = True) -> None:
        del calibrate
        self.arm.ConnectPort(can_init=True)
        try:
            require_firmware(self.arm, self.config.connect_timeout_s)
            set_role(self.arm, PIPER_ROLE_FOLLOWER)
            self._last_action = wait_feedback(self.arm, self.config.connect_timeout_s)
            set_role(self.arm, PIPER_ROLE_LEADER)
            time.sleep(0.1)
            self._joint_timestamp = self.arm.GetArmJointCtrl().time_stamp
            self._gripper_timestamp = self.arm.GetArmGripperCtrl().time_stamp
            self._is_connected = True
        except Exception:
            self.arm.DisconnectPort()
            self._last_action = None
            raise

    @property
    def is_calibrated(self) -> bool:
        return True

    def calibrate(self) -> None:
        return None

    def configure(self) -> None:
        if not self._is_connected:
            raise ConnectionError(f"{self} 尚未连接")
        set_role(self.arm, PIPER_ROLE_LEADER)

    @check_if_not_connected
    def get_action(self) -> RobotAction:
        if self._last_action is None:
            raise RuntimeError("PiperX 主臂尚未取得初始状态")
        joint_message = self.arm.GetArmJointCtrl()
        if joint_message.time_stamp > 0 and joint_message.time_stamp != self._joint_timestamp:
            joints = joint_message.joint_ctrl
            self._last_action.update(
                {key: float(getattr(joints, key.removesuffix(".pos"))) * 1e-3 for key in PIPER_JOINT_KEYS}
            )
            self._joint_timestamp = joint_message.time_stamp
        gripper_message = self.arm.GetArmGripperCtrl()
        if gripper_message.time_stamp > 0 and gripper_message.time_stamp != self._gripper_timestamp:
            self._last_action["gripper.pos"] = abs(float(gripper_message.gripper_ctrl.grippers_angle) * 1e-3)
            self._gripper_timestamp = gripper_message.time_stamp
        return validate_action(self._last_action)

    def send_feedback(self, feedback: dict[str, Any]) -> None:
        del feedback

    @check_if_not_connected
    def disconnect(self) -> None:
        self.arm.DisconnectPort()
        self._is_connected = False
        self._last_action = None


class BiPiperXFollower(Robot):
    config_class = BiPiperXFollowerConfig
    name = "bi_piperx_follower"

    def __init__(self, config: BiPiperXFollowerConfig):
        super().__init__(config)
        self.config = config
        follower_type = _FollowerProxy if config.process_isolation else PiperXFollower
        self.left = follower_type(config.left_arm_config)
        self.right = follower_type(config.right_arm_config)
        self.cameras = make_cameras_from_configs(config.cameras)

    @cached_property
    def observation_features(self) -> dict[str, type | tuple]:
        cameras = {key: (config.height, config.width, 3) for key, config in self.config.cameras.items()}
        return {
            **{f"left_{key}": value for key, value in self.left.observation_features.items()},
            **{f"right_{key}": value for key, value in self.right.observation_features.items()},
            **cameras,
        }

    @cached_property
    def action_features(self) -> dict[str, type]:
        return {
            **{f"left_{key}": value for key, value in self.left.action_features.items()},
            **{f"right_{key}": value for key, value in self.right.action_features.items()},
        }

    @property
    def is_connected(self) -> bool:
        return (
            self.left.is_connected
            and self.right.is_connected
            and all(camera.is_connected for camera in self.cameras.values())
        )

    def connect(self, calibrate: bool = True) -> None:
        del calibrate
        connected_cameras = []
        self.left.connect(calibrate=False)
        try:
            self.right.connect(calibrate=False)
            for camera in self.cameras.values():
                camera.connect()
                connected_cameras.append(camera)
        except Exception:
            for camera in connected_cameras:
                with suppress(Exception):
                    camera.disconnect()
            with suppress(Exception):
                self.right.disconnect()
            self.left.disconnect()
            raise

    @property
    def is_calibrated(self) -> bool:
        return True

    def calibrate(self) -> None:
        return None

    def configure(self) -> None:
        self.left.configure()
        self.right.configure()

    def get_observation(self) -> RobotObservation:
        observation = {
            **{f"left_{key}": value for key, value in self.left.get_observation().items()},
            **{f"right_{key}": value for key, value in self.right.get_observation().items()},
        }
        for key, camera in self.cameras.items():
            observation[key] = camera.async_read()
        return observation

    def send_action(self, action: RobotAction) -> RobotAction:
        left = {key: action[f"left_{key}"] for key in PIPER_ACTION_KEYS}
        right = {key: action[f"right_{key}"] for key in PIPER_ACTION_KEYS}
        left_sent = self.left.send_action(left)
        right_sent = self.right.send_action(right)
        return {
            **{f"left_{key}": value for key, value in left_sent.items()},
            **{f"right_{key}": value for key, value in right_sent.items()},
        }

    def disconnect(self) -> None:
        errors = []
        for device in (*self.cameras.values(), self.right, self.left):
            try:
                device.disconnect()
            except Exception as error:
                errors.append(error)
        if errors:
            raise RuntimeError("断开双臂 PiperX 时发生错误") from errors[0]


def _leader_worker(connection: Any, config: PiperXLeaderConfig) -> None:
    leader = PiperXLeader(config)
    try:
        while True:
            request = connection.recv()
            if request["method"] == "__close__":
                break
            try:
                result = getattr(leader, request["method"])(*request.get("args", ()))
                connection.send({"ok": True, "result": result})
            except Exception as error:
                connection.send({"ok": False, "error": str(error), "traceback": traceback.format_exc()})
    finally:
        with suppress(Exception):
            if leader.is_connected:
                leader.disconnect()
        connection.close()


def _follower_worker(connection: Any, config: PiperXFollowerConfig) -> None:
    follower = PiperXFollower(config)
    try:
        while True:
            request = connection.recv()
            if request["method"] == "__close__":
                break
            try:
                result = getattr(follower, request["method"])(*request.get("args", ()))
                connection.send({"ok": True, "result": result})
            except Exception as error:
                connection.send({"ok": False, "error": str(error), "traceback": traceback.format_exc()})
    finally:
        with suppress(Exception):
            if follower.is_connected:
                follower.disconnect()
        connection.close()


class _FollowerProxy:
    def __init__(self, config: PiperXFollowerConfig):
        self.config = config
        self.context = mp.get_context("spawn")
        self.connection = None
        self.process = None
        self._is_connected = False

    @property
    def observation_features(self) -> dict[str, type]:
        return dict.fromkeys(PIPER_ACTION_KEYS, float)

    @property
    def action_features(self) -> dict[str, type]:
        return dict.fromkeys(PIPER_ACTION_KEYS, float)

    @property
    def is_connected(self) -> bool:
        return self._is_connected

    def _call(self, method: str, *args: Any) -> Any:
        if self.process is None or not self.process.is_alive():
            parent, child = self.context.Pipe()
            self.process = self.context.Process(target=_follower_worker, args=(child, self.config))
            self.process.start()
            child.close()
            self.connection = parent
        self.connection.send({"method": method, "args": args})
        response = self.connection.recv()
        if response["ok"]:
            return response.get("result")
        raise RuntimeError(
            f"PiperX 从臂子进程执行 {method} 失败：{response['error']}\n{response['traceback']}"
        )

    def connect(self, calibrate: bool = True) -> None:
        self._call("connect", calibrate)
        self._is_connected = True

    def configure(self) -> None:
        self._call("configure")

    def get_observation(self) -> RobotObservation:
        return self._call("get_observation")

    def send_action(self, action: RobotAction) -> RobotAction:
        return self._call("send_action", action)

    def disconnect(self) -> None:
        if self.process is None:
            return
        with suppress(Exception):
            if self._is_connected:
                self._call("disconnect")
        with suppress(Exception):
            self.connection.send({"method": "__close__"})
        self.process.join(timeout=2)
        if self.process.is_alive():
            self.process.terminate()
            self.process.join(timeout=1)
        self._is_connected = False


class _LeaderProxy:
    def __init__(self, config: PiperXLeaderConfig):
        self.config = config
        self.context = mp.get_context("spawn")
        self.connection = None
        self.process = None
        self._is_connected = False

    @property
    def action_features(self) -> dict[str, type]:
        return dict.fromkeys(PIPER_ACTION_KEYS, float)

    @property
    def is_connected(self) -> bool:
        return self._is_connected

    def _call(self, method: str, *args: Any) -> Any:
        if self.process is None or not self.process.is_alive():
            parent, child = self.context.Pipe()
            self.process = self.context.Process(target=_leader_worker, args=(child, self.config))
            self.process.start()
            child.close()
            self.connection = parent
        self.connection.send({"method": method, "args": args})
        response = self.connection.recv()
        if response["ok"]:
            return response.get("result")
        raise RuntimeError(
            f"PiperX 主臂子进程执行 {method} 失败：{response['error']}\n{response['traceback']}"
        )

    def connect(self) -> None:
        self._call("connect", False)
        self._is_connected = True

    def get_action(self) -> RobotAction:
        return self._call("get_action")

    def disconnect(self) -> None:
        if self.process is None:
            return
        with suppress(Exception):
            if self._is_connected:
                self._call("disconnect")
        with suppress(Exception):
            self.connection.send({"method": "__close__"})
        self.process.join(timeout=2)
        if self.process.is_alive():
            self.process.terminate()
            self.process.join(timeout=1)
        self._is_connected = False


class BiPiperXLeader(Teleoperator):
    config_class = BiPiperXLeaderConfig
    name = "bi_piperx_leader"

    def __init__(self, config: BiPiperXLeaderConfig):
        super().__init__(config)
        self.config = config
        leader_type = _LeaderProxy if config.process_isolation else PiperXLeader
        self.left = leader_type(config.left_arm_config)
        self.right = leader_type(config.right_arm_config)

    @cached_property
    def action_features(self) -> dict[str, type]:
        return {
            **{f"left_{key}": value for key, value in self.left.action_features.items()},
            **{f"right_{key}": value for key, value in self.right.action_features.items()},
        }

    @cached_property
    def feedback_features(self) -> dict[str, type]:
        return {}

    @property
    def is_connected(self) -> bool:
        return self.left.is_connected and self.right.is_connected

    def connect(self, calibrate: bool = True) -> None:
        del calibrate
        self.left.connect()
        try:
            self.right.connect()
        except Exception:
            self.left.disconnect()
            raise

    @property
    def is_calibrated(self) -> bool:
        return True

    def calibrate(self) -> None:
        return None

    def configure(self) -> None:
        if not self.is_connected:
            raise ConnectionError(f"{self} 尚未连接")

    def get_action(self) -> RobotAction:
        left = self.left.get_action()
        right = self.right.get_action()
        return {
            **{f"left_{key}": value for key, value in left.items()},
            **{f"right_{key}": value for key, value in right.items()},
        }

    def send_feedback(self, feedback: dict[str, Any]) -> None:
        del feedback

    def disconnect(self) -> None:
        errors = []
        for leader in (self.right, self.left):
            try:
                leader.disconnect()
            except Exception as error:
                errors.append(error)
        if errors:
            raise RuntimeError("断开双臂 PiperX 主臂时发生错误") from errors[0]
