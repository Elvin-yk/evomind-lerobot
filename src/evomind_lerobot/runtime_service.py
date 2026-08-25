"""Run native LeRobot workflows behind the local HTTP runtime."""

from __future__ import annotations

import multiprocessing
import os
import signal
import threading
from queue import Empty
from typing import Any, Literal

from pydantic import BaseModel, Field

from evomind_lerobot.device_config import (
    DeviceConfiguration,
    calibration_path,
    load_device_configuration,
    runtime_id,
)
from evomind_lerobot.events import EventBroker, Operation, Phase
from evomind_lerobot.jobs import HardwareBusyError, JobManager
from evomind_lerobot.workspace import datasets_inventory


class TeleoperationStartRequest(BaseModel):
    fps: int = Field(default=30, ge=1, le=60)


class RecordingStartRequest(BaseModel):
    dataset_name: str = Field(min_length=1, max_length=80)
    task: str = Field(min_length=1, max_length=500)
    fps: int = Field(default=30, ge=1, le=60)
    num_episodes: int = Field(default=20, ge=1, le=10_000)
    episode_time_s: int = Field(default=30, ge=1, le=86_400)
    reset_time_s: int = Field(default=10, ge=0, le=86_400)


class RolloutStartRequest(BaseModel):
    policy_path: str = Field(min_length=1)
    strategy: Literal["episodic", "sentry"] = "episodic"
    task: str = Field(min_length=1, max_length=500)
    dataset_name: str = Field(default="policy-rollout", min_length=1, max_length=80)
    fps: int = Field(default=30, ge=1, le=60)
    duration_s: int = Field(default=120, ge=1, le=86_400)
    num_episodes: int = Field(default=10, ge=1, le=10_000)
    episode_time_s: int = Field(default=30, ge=1, le=86_400)
    reset_time_s: int = Field(default=10, ge=0, le=86_400)


class ReplayStartRequest(BaseModel):
    dataset_id: str = Field(min_length=1)
    episode: int = Field(default=0, ge=0)


class RuntimeCommandRequest(BaseModel):
    command: Literal["stop", "finish_episode", "rerecord_episode"]


_MESSAGES = {
    ("teleoperation", "starting"): "正在启动遥操作",
    ("teleoperation", "connecting"): "正在连接遥操作设备和机械臂",
    ("teleoperation", "running"): "遥操作运行中",
    ("teleoperation", "stopping"): "正在停止遥操作",
    ("teleoperation", "completed"): "遥操作已结束",
    ("recording", "starting"): "正在启动数据采集",
    ("recording", "connecting"): "正在连接采集设备",
    ("recording", "running"): "数据采集中",
    ("recording", "resetting"): "正在重置场景",
    ("recording", "saving"): "正在保存 Episode",
    ("recording", "stopping"): "正在停止数据采集",
    ("recording", "completed"): "数据采集已结束",
    ("rollout", "starting"): "正在加载 Policy",
    ("rollout", "connecting"): "正在连接推理设备",
    ("rollout", "running"): "Policy 推理运行中",
    ("rollout", "stopping"): "正在停止推理",
    ("rollout", "completed"): "推理已结束",
    ("replay", "starting"): "正在加载回放数据",
    ("replay", "connecting"): "正在连接回放设备",
    ("replay", "running"): "数据回放中",
    ("replay", "stopping"): "正在停止回放",
    ("replay", "completed"): "回放已结束",
}


class ProcessRuntimeBridge:
    """RuntimeBridge implementation used inside a workflow process."""

    def __init__(self, event_queue: Any, command_queue: Any) -> None:
        self._event_queue = event_queue
        self._command_queue = command_queue

    def emit(self, operation: str, phase: str, data: dict[str, Any]) -> None:
        self._event_queue.put(
            {"kind": "event", "operation": operation, "phase": phase, "data": data}
        )

    def take_commands(self) -> set[str]:
        commands: set[str] = set()
        while True:
            try:
                commands.add(self._command_queue.get_nowait())
            except Empty:
                return commands

    def prompt(self, prompt_id: str, message: str) -> str:
        raise RuntimeError(f"当前网页尚未处理运行时确认：{prompt_id} · {message}")


def _repo_id(value: str) -> str:
    repo_id = value.strip()
    if not repo_id:
        raise ValueError("数据集 repo id 不能为空")
    return repo_id


def _camera_config(port: str, fps: int) -> dict[str, Any]:
    return {
        "type": "opencv",
        "index_or_path": port,
        "fps": min(fps, 30),
        "width": 640,
        "height": 480,
    }


def _camera_key(alias: str, side: str) -> str:
    prefix = f"{side}_"
    return alias.removeprefix(prefix) if side in {"left", "right"} else alias


def _robot_payload(configuration: DeviceConfiguration, fps: int, *, cameras: bool) -> dict[str, Any]:
    bindings = [item for item in configuration.serial_bindings if item.kind == "robot"]
    payload: dict[str, Any] = {
        "type": configuration.robot_type,
        "id": runtime_id(configuration, "robot"),
    }

    camera_bindings = configuration.camera_bindings if cameras else []
    dual = {binding.side for binding in bindings} >= {"left", "right"}
    if dual:
        for side in ("left", "right"):
            binding = next(item for item in bindings if item.side == side)
            side_cameras = {
                _camera_key(camera.alias, side): _camera_config(camera.port, fps)
                for camera in camera_bindings
                if camera.side == side
            }
            payload[f"{side}_arm_config"] = {"port": binding.port, "cameras": side_cameras}
        payload["cameras"] = {
            camera.alias: _camera_config(camera.port, fps)
            for camera in camera_bindings
            if camera.side == "single"
        }
    elif bindings:
        payload["port"] = bindings[0].port
        payload["cameras"] = {
            camera.alias: _camera_config(camera.port, fps) for camera in camera_bindings
        }
    return payload


def _teleoperator_payload(configuration: DeviceConfiguration) -> dict[str, Any] | None:
    if configuration.teleoperator_type is None:
        return None
    bindings = [item for item in configuration.serial_bindings if item.kind == "teleoperator"]
    payload: dict[str, Any] = {
        "type": configuration.teleoperator_type,
        "id": runtime_id(configuration, "teleoperator"),
    }
    dual = {binding.side for binding in bindings} >= {"left", "right"}
    if dual:
        for side in ("left", "right"):
            binding = next(item for item in bindings if item.side == side)
            payload[f"{side}_arm_config"] = {"port": binding.port}
    elif bindings:
        payload["port"] = bindings[0].port
    return payload


def _configuration() -> DeviceConfiguration:
    configuration = load_device_configuration()
    if configuration is None or not configuration.serial_bindings:
        raise ValueError("请先完成设备识别")
    return configuration


def _require_calibration(configuration: DeviceConfiguration, kind: str) -> None:
    missing = [
        binding.alias
        for binding in configuration.serial_bindings
        if binding.kind == kind and not calibration_path(configuration, binding).is_file()
    ]
    if missing:
        raise ValueError(f"请先校准设备：{', '.join(missing)}")


def _decode_hardware(
    configuration: DeviceConfiguration,
    fps: int,
    *,
    cameras: bool = True,
    include_teleoperator: bool = True,
):
    import draccus

    from lerobot.robots.config import RobotConfig
    from lerobot.scripts import lerobot_teleoperate as _core_hardware_configs  # noqa: F401
    from lerobot.teleoperators.config import TeleoperatorConfig
    from lerobot.utils.import_utils import register_third_party_plugins

    register_third_party_plugins()
    _require_calibration(configuration, "robot")
    robot = draccus.decode(RobotConfig, _robot_payload(configuration, fps, cameras=cameras))
    teleop_payload = _teleoperator_payload(configuration) if include_teleoperator else None
    if teleop_payload:
        _require_calibration(configuration, "teleoperator")
    teleop = draccus.decode(TeleoperatorConfig, teleop_payload) if teleop_payload else None
    return robot, teleop


def _execute_teleoperation(payload: dict[str, Any]) -> None:
    from lerobot.scripts.lerobot_teleoperate import TeleoperateConfig, teleoperate

    request = TeleoperationStartRequest.model_validate(payload)
    robot, teleop = _decode_hardware(_configuration(), request.fps, cameras=False)
    if teleop is None:
        raise ValueError("当前设备没有遥操作设备")
    teleoperate(
        TeleoperateConfig(
            robot=robot,
            teleop=teleop,
            fps=request.fps,
            display_data=False,
        )
    )


def _execute_recording(payload: dict[str, Any]) -> None:
    from lerobot.configs.dataset import DatasetRecordConfig
    from lerobot.scripts.lerobot_record import RecordConfig, record

    request = RecordingStartRequest.model_validate(payload)
    robot, teleop = _decode_hardware(_configuration(), request.fps)
    if teleop is None:
        raise ValueError("当前设备没有遥操作设备")
    record(
        RecordConfig(
            robot=robot,
            teleop=teleop,
            dataset=DatasetRecordConfig(
                repo_id=_repo_id(request.dataset_name),
                single_task=request.task,
                fps=request.fps,
                num_episodes=request.num_episodes,
                episode_time_s=request.episode_time_s,
                reset_time_s=request.reset_time_s,
                push_to_hub=False,
            ),
            display_data=False,
            play_sounds=False,
        )
    )


def _execute_rollout(payload: dict[str, Any]) -> None:
    from lerobot.configs import PreTrainedConfig
    from lerobot.configs.dataset import DatasetRecordConfig
    from lerobot.rollout.configs import EpisodicStrategyConfig, RolloutConfig, SentryStrategyConfig
    from lerobot.scripts.lerobot_rollout import rollout

    request = RolloutStartRequest.model_validate(payload)
    robot, teleop = _decode_hardware(_configuration(), request.fps)
    policy = PreTrainedConfig.from_pretrained(request.policy_path)
    policy.pretrained_path = request.policy_path
    dataset = DatasetRecordConfig(
        repo_id=_repo_id(request.dataset_name),
        single_task=request.task,
        fps=request.fps,
        num_episodes=request.num_episodes,
        episode_time_s=request.episode_time_s,
        reset_time_s=request.reset_time_s,
        push_to_hub=False,
    )
    strategy = EpisodicStrategyConfig() if request.strategy == "episodic" else SentryStrategyConfig()
    rollout(
        RolloutConfig(
            robot=robot,
            teleop=teleop if request.strategy == "episodic" else None,
            policy=policy,
            strategy=strategy,
            dataset=dataset,
            fps=request.fps,
            duration=request.duration_s,
            task=request.task,
            display_data=False,
            play_sounds=False,
        )
    )


def _dataset(dataset_id: str) -> dict[str, Any]:
    available = {item["id"]: item for item in datasets_inventory()}
    if dataset_id not in available:
        raise ValueError("选择的数据集不在本地数据目录中")
    return available[dataset_id]


def _execute_replay(payload: dict[str, Any]) -> None:
    from lerobot.scripts.lerobot_replay import DatasetReplayConfig, ReplayConfig, replay

    request = ReplayStartRequest.model_validate(payload)
    dataset = _dataset(request.dataset_id)
    if request.episode >= dataset["episodes"]:
        raise ValueError("Episode 超出数据集范围")
    robot, _ = _decode_hardware(
        _configuration(),
        dataset["fps"],
        cameras=False,
        include_teleoperator=False,
    )
    replay(
        ReplayConfig(
            robot=robot,
            dataset=DatasetReplayConfig(
                repo_id=dataset["id"],
                episode=request.episode,
            ),
            play_sounds=False,
        )
    )


_EXECUTORS = {
    "teleoperation": _execute_teleoperation,
    "recording": _execute_recording,
    "rollout": _execute_rollout,
    "replay": _execute_replay,
}


def _run_workflow(
    operation: str,
    payload: dict[str, Any],
    event_queue: Any,
    command_queue: Any,
) -> None:
    from lerobot.utils.runtime_bridge import use_runtime_bridge

    bridge = ProcessRuntimeBridge(event_queue, command_queue)
    try:
        with use_runtime_bridge(bridge):
            _EXECUTORS[operation](payload)
    except BaseException as error:
        event_queue.put({"kind": "exit", "error": str(error) or error.__class__.__name__})
    else:
        event_queue.put({"kind": "exit", "error": ""})


class RuntimeService:
    """Own one native LeRobot workflow process at a time."""

    def __init__(self, events: EventBroker, jobs: JobManager) -> None:
        self._events = events
        self._jobs = jobs
        self._context = multiprocessing.get_context("spawn")
        self._lock = threading.RLock()
        self._process: multiprocessing.Process | None = None
        self._event_queue: Any = None
        self._command_queue: Any = None
        self._job_id = ""
        self._operation: Operation | None = None
        self._latest: dict[str, Any] | None = None

    def status(self) -> dict[str, Any]:
        with self._lock:
            process = self._process
            return {
                "running": bool(process and process.is_alive()),
                "job_id": self._job_id or None,
                "operation": self._operation.value if self._operation else None,
                "event": self._latest,
            }

    def start(self, operation: Operation, request: BaseModel) -> dict[str, Any]:
        if operation.value not in _EXECUTORS:
            raise ValueError(f"不支持的运行任务：{operation.value}")
        job = self._jobs.acquire(operation, f"正在启动 {operation.value}")
        event_queue = self._context.Queue()
        command_queue = self._context.Queue()
        process = self._context.Process(
            target=_run_workflow,
            args=(operation.value, request.model_dump(), event_queue, command_queue),
            name=f"evomind-{operation.value}",
        )
        with self._lock:
            self._process = process
            self._event_queue = event_queue
            self._command_queue = command_queue
            self._job_id = job.id
            self._operation = operation
            self._latest = self._events.latest.as_dict()
        try:
            process.start()
        except BaseException:
            self._clear()
            self._jobs.release(job.id, failed=True, message="运行任务启动失败")
            raise
        threading.Thread(target=self._monitor, name=f"monitor-{operation.value}", daemon=True).start()
        return self.status()

    def command(self, command: str) -> dict[str, Any]:
        with self._lock:
            process = self._process
            command_queue = self._command_queue
            operation = self._operation
        if process is None or not process.is_alive() or command_queue is None:
            raise RuntimeError("当前没有运行中的任务")
        if command != "stop" and operation is not Operation.RECORDING:
            raise ValueError("当前任务不支持这个操作")
        command_queue.put(command)
        if command == "stop" and operation is Operation.ROLLOUT:
            os.kill(process.pid, signal.SIGINT)
        return self.status()

    def _monitor(self) -> None:
        error = ""
        while True:
            with self._lock:
                process = self._process
                event_queue = self._event_queue
                job_id = self._job_id
                operation = self._operation
            if process is None or event_queue is None or operation is None:
                return
            try:
                item = event_queue.get(timeout=0.2)
            except Empty:
                if process.is_alive():
                    continue
                break
            if item["kind"] == "exit":
                error = item["error"]
                break
            phase = Phase(item["phase"])
            message = _MESSAGES.get((item["operation"], item["phase"]), item["phase"])
            event = self._events.publish(
                Operation(item["operation"]),
                phase,
                message,
                job_id=job_id,
                data=item["data"],
            )
            with self._lock:
                self._latest = event.as_dict()
        process.join(timeout=1)
        if error:
            event = self._events.publish(
                operation,
                Phase.FAILED,
                error,
                job_id=job_id,
            )
            with self._lock:
                self._latest = event.as_dict()
        self._clear()
        self._jobs.release(
            job_id,
            failed=bool(error),
            message=error or _MESSAGES.get((operation.value, "completed"), "任务已完成"),
        )

    def _clear(self) -> None:
        with self._lock:
            self._process = None
            self._event_queue = None
            self._command_queue = None
            self._job_id = ""
            self._operation = None


__all__ = [
    "HardwareBusyError",
    "RecordingStartRequest",
    "ReplayStartRequest",
    "RolloutStartRequest",
    "RuntimeCommandRequest",
    "RuntimeService",
    "TeleoperationStartRequest",
]
