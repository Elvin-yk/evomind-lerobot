"""Run native LeRobot workflows behind the local HTTP runtime."""

from __future__ import annotations

import logging
import multiprocessing
import os
import re
import signal
import sqlite3
import threading
from queue import Empty
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field

from evomind_lerobot.collection_store import CollectionStore, CollectionStoreError
from evomind_lerobot.device_config import (
    CameraBinding,
    CanBinding,
    DeviceConfiguration,
    SerialBinding,
    calibration_path,
    load_device_configuration,
    runtime_id,
)
from evomind_lerobot.events import EventBroker, Operation, Phase
from evomind_lerobot.jobs import HardwareBusyError, JobManager
from evomind_lerobot.workspace import datasets_inventory, policies_inventory


class TeleoperationStartRequest(BaseModel):
    fps: int = Field(default=30, ge=1, le=60)


class RecordingStartRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    task_id: str = Field(min_length=1)


class CollectionStartRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    task_id: str = Field(min_length=1)


class RecordingExecutionRequest(RecordingStartRequest):
    fps: int = Field(ge=1, le=60)
    num_episodes: int = Field(ge=1, le=10_000)
    episode_time_s: int = Field(ge=1, le=86_400)
    reset_time_s: int = Field(ge=0, le=86_400)


class RolloutStartRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    policy_path: str = Field(min_length=1)
    strategy: Literal[
        "base",
        "episodic",
        "sentry",
        "highlight",
        "dagger_corrections",
        "dagger_continuous",
    ] = "base"
    inference: Literal["sync", "rtc"] = "sync"
    task: str = Field(min_length=1, max_length=500)
    dataset_name: str = Field(default="rollout_policy-rollout", min_length=1, max_length=80)
    fps: int = Field(default=30, ge=1, le=60)
    duration_s: int = Field(default=120, ge=1, le=86_400)
    num_episodes: int = Field(default=10, ge=1, le=10_000)
    episode_time_s: int = Field(default=30, ge=1, le=86_400)
    reset_time_s: int = Field(default=10, ge=0, le=86_400)
    ring_buffer_seconds: int = Field(default=10, ge=1, le=300)


class PolicyInspectRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    policy_path: str = Field(min_length=1)


class ReplayStartRequest(BaseModel):
    dataset_id: str = Field(min_length=1)
    episode: int = Field(default=0, ge=0)


class RuntimeCommandRequest(BaseModel):
    command: Literal[
        "stop",
        "finish_episode",
        "rerecord_episode",
        "pause_resume",
        "correction",
        "toggle_highlight",
    ]


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
        self._event_queue.put({"kind": "event", "operation": operation, "phase": phase, "data": data})

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


def _rollout_repo_id(value: str) -> str:
    """Ensure rollout datasets follow LeRobot's required basename convention."""
    repo_id = _repo_id(value)
    namespace, separator, name = repo_id.rpartition("/")
    if not name.startswith("rollout_"):
        name = f"rollout_{name}"
    return f"{namespace}/{name}" if separator else name


def _policy_path(value: str) -> str:
    """Accept either a Hub repo id, local path, or a pasted Hugging Face URL."""
    path = value.strip().rstrip("/")
    match = re.fullmatch(r"https?://huggingface\.co/([^/]+/[^/]+)(?:/.*)?", path)
    return match.group(1) if match else path


def require_local_policy(value: str) -> str:
    """Resolve a policy selected from the local workspace inventory."""
    selected = value.strip()
    for policy in policies_inventory():
        if selected in {policy["id"], policy["path"]}:
            return policy["path"]
    raise ValueError("选择的 Policy 不在本机模型目录中")


def _recording_dataset_name(task: dict[str, Any]) -> str:
    """Build a readable, filesystem-safe dataset name from the selected daily task."""
    name = re.sub(r"[^\w.-]+", "-", str(task["name"]).strip(), flags=re.UNICODE).strip("-._")
    task_prefix = str(task["id"]).split("-", 1)[0]
    return f"{name[:48] or 'recording'}_{task_prefix}"


def _camera_config(binding: CameraBinding, fps: int) -> dict[str, Any]:
    if binding.driver == "intelrealsense":
        return {
            "type": "intelrealsense",
            "serial_number_or_name": binding.serial_number,
            "fps": min(fps, 30),
            "width": 640,
            "height": 480,
            "warmup_s": 2,
            "use_rgb": True,
            "use_depth": False,
        }
    return {
        "type": "opencv",
        "index_or_path": binding.port,
        "fps": min(fps, 30),
        "width": 640,
        "height": 480,
        "warmup_s": 3,
        "fourcc": "MJPG",
    }


def _camera_key(alias: str, side: str) -> str:
    prefix = f"{side}_"
    return alias.removeprefix(prefix) if side in {"left", "right"} else alias


def _device_bindings(configuration: DeviceConfiguration, kind: str) -> list[SerialBinding | CanBinding]:
    return [
        binding
        for binding in [*configuration.serial_bindings, *configuration.can_bindings]
        if binding.kind == kind
    ]


def _binding_port(binding: SerialBinding | CanBinding) -> str:
    return binding.port if isinstance(binding, SerialBinding) else binding.id


def _robot_payload(configuration: DeviceConfiguration, fps: int, *, cameras: bool) -> dict[str, Any]:
    bindings = _device_bindings(configuration, "robot")
    payload: dict[str, Any] = {
        "type": configuration.robot_type,
        "id": runtime_id(configuration, "robot"),
    }

    camera_bindings = configuration.camera_bindings if cameras else []
    dual = {binding.side for binding in bindings} >= {"left", "right"}
    if dual:
        supports_top_level_cameras = configuration.robot_type == "bi_so_follower"
        for side in ("left", "right"):
            binding = next(item for item in bindings if item.side == side)
            side_cameras = {
                _camera_key(camera.alias, side): _camera_config(camera, fps)
                for camera in camera_bindings
                if camera.side == side
                or (not supports_top_level_cameras and side == "right" and camera.side == "single")
            }
            payload[f"{side}_arm_config"] = {
                "port": _binding_port(binding),
                "cameras": side_cameras,
            }
        # Bimanual LeRobot robots expose top-level cameras without a left/right
        # prefix.  Keeping environment cameras here also avoids silently dropping
        # them on serial dual-arm configurations.
        if supports_top_level_cameras:
            payload["cameras"] = {
                camera.alias: _camera_config(camera, fps)
                for camera in camera_bindings
                if camera.side == "single"
            }
    elif bindings:
        payload["port"] = _binding_port(bindings[0])
        payload["cameras"] = {camera.alias: _camera_config(camera, fps) for camera in camera_bindings}
    return payload


def _configured_visual_features(configuration: DeviceConfiguration) -> set[str]:
    """Return policy-facing visual keys without opening cameras or serial ports."""
    bindings = _device_bindings(configuration, "robot")
    dual = {binding.side for binding in bindings} >= {"left", "right"}
    keys: set[str] = set()
    for camera in configuration.camera_bindings:
        if dual and camera.side in {"left", "right"}:
            name = f"{camera.side}_{_camera_key(camera.alias, camera.side)}"
        elif dual and configuration.robot_type != "bi_so_follower":
            name = f"right_{camera.alias}"
        else:
            name = camera.alias
        keys.add(f"observation.images.{name}")
    return keys


def _configured_vector_dimensions(configuration: DeviceConfiguration) -> tuple[int | None, int | None]:
    """Infer fixed arm vector dimensions for compatibility checks."""
    robot_count = len(_device_bindings(configuration, "robot"))
    if configuration.robot_type in {"so100_follower", "so101_follower", "bi_so_follower"}:
        dimension = 6 * robot_count
        return dimension, dimension
    return None, None


def _camera_rename_map(
    configuration: DeviceConfiguration,
    expected: set[str],
    provided: set[str],
) -> dict[str, str]:
    """Resolve unambiguous camera aliases, primarily environment -> front."""
    missing = expected - provided
    extra = provided - expected
    if not missing or not extra:
        return {}

    slot_by_feature = {
        f"observation.images.{slot.alias}": slot
        for slot in configuration.camera_slots
        if slot.side == "single"
    }
    rename_map: dict[str, str] = {}
    for source in sorted(extra):
        slot = slot_by_feature.get(source)
        if slot is None:
            continue
        candidates = [
            target
            for target in missing
            if slot.kind == "environment"
            and any(token in target.rsplit(".", 1)[-1] for token in ("front", "environment", "top"))
        ]
        if len(candidates) == 1:
            rename_map[source] = candidates[0]
            missing.remove(candidates[0])
    return rename_map


def _teleoperator_payload(configuration: DeviceConfiguration) -> dict[str, Any] | None:
    if configuration.teleoperator_type is None:
        return None
    bindings = _device_bindings(configuration, "teleoperator")
    payload: dict[str, Any] = {
        "type": configuration.teleoperator_type,
        "id": runtime_id(configuration, "teleoperator"),
    }
    dual = {binding.side for binding in bindings} >= {"left", "right"}
    if dual:
        for side in ("left", "right"):
            binding = next(item for item in bindings if item.side == side)
            payload[f"{side}_arm_config"] = {"port": _binding_port(binding)}
    elif bindings:
        payload["port"] = _binding_port(bindings[0])
    return payload


def _configuration() -> DeviceConfiguration:
    configuration = load_device_configuration()
    if configuration is None or not (configuration.serial_bindings or configuration.can_bindings):
        raise ValueError("请先完成设备识别")
    return configuration


def _require_calibration(configuration: DeviceConfiguration, kind: str) -> None:
    configured_type = configuration.robot_type if kind == "robot" else configuration.teleoperator_type or ""
    if "piperx" in configured_type:
        return
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

    from lerobot.cameras.opencv.configuration_opencv import (  # noqa: F401
        OpenCVCameraConfig as _OpenCVCameraConfig,
    )
    from lerobot.cameras.realsense.configuration_realsense import (  # noqa: F401
        RealSenseCameraConfig as _RealSenseCameraConfig,
    )
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
    from lerobot.configs.video import RGBEncoderConfig
    from lerobot.scripts.lerobot_record import RecordConfig, record

    task_description = str(payload.pop("_task_description"))
    dataset_name = str(payload.pop("_dataset_name"))
    request = RecordingExecutionRequest.model_validate(payload)
    robot, teleop = _decode_hardware(_configuration(), request.fps)
    if teleop is None:
        raise ValueError("当前设备没有遥操作设备")
    record(
        RecordConfig(
            robot=robot,
            teleop=teleop,
            dataset=DatasetRecordConfig(
                repo_id=_repo_id(dataset_name),
                single_task=task_description,
                fps=request.fps,
                num_episodes=request.num_episodes,
                episode_time_s=request.episode_time_s,
                reset_time_s=request.reset_time_s,
                push_to_hub=False,
                streaming_encoding=True,
                encoder_threads=2,
                encoder_queue_maxsize=30,
                rgb_encoder=RGBEncoderConfig(vcodec="h264"),
            ),
            display_data=False,
            play_sounds=False,
        )
    )


def inspect_policy_compatibility(request: PolicyInspectRequest) -> dict[str, Any]:
    """Inspect checkpoint metadata and compare it with configured hardware.

    This deliberately downloads only metadata/configuration files.  It never
    loads model weights, opens cameras, connects serial ports, or moves a robot.
    """
    from lerobot import policies as _policy_configs  # noqa: F401
    from lerobot.configs import FeatureType, PreTrainedConfig
    from lerobot.utils.import_utils import register_third_party_plugins

    register_third_party_plugins()
    path = _policy_path(request.policy_path)
    policy = PreTrainedConfig.from_pretrained(path)
    configuration = _configuration()

    expected_visuals = {
        key for key, feature in policy.input_features.items() if feature.type == FeatureType.VISUAL
    }
    provided_visuals = _configured_visual_features(configuration)
    rename_map = _camera_rename_map(configuration, expected_visuals, provided_visuals)
    renamed_visuals = {rename_map.get(key, key) for key in provided_visuals}

    state_feature = policy.input_features.get("observation.state")
    action_feature = policy.output_features.get("action")
    state_dim = state_feature.shape[-1] if state_feature and state_feature.shape else None
    action_dim = action_feature.shape[-1] if action_feature and action_feature.shape else None
    hardware_state_dim, hardware_action_dim = _configured_vector_dimensions(configuration)

    issues: list[str] = []
    missing_visuals = sorted(expected_visuals - renamed_visuals)
    if missing_visuals:
        issues.append(f"缺少模型摄像头输入：{', '.join(missing_visuals)}")
    if hardware_state_dim is not None and state_dim is not None and hardware_state_dim != state_dim:
        issues.append(f"状态维度不匹配：模型 {state_dim}，设备 {hardware_state_dim}")
    if hardware_action_dim is not None and action_dim is not None and hardware_action_dim != action_dim:
        issues.append(f"动作维度不匹配：模型 {action_dim}，设备 {hardware_action_dim}")

    revision: str | None = None
    size_bytes: int | None = None
    if not os.path.exists(path):
        try:
            from huggingface_hub import HfApi

            info = HfApi().model_info(path, files_metadata=True)
            revision = info.sha
            sizes = [sibling.size for sibling in info.siblings if sibling.size is not None]
            size_bytes = sum(sizes) if sizes else None
        except Exception:
            logging.info("Could not read optional Hub model metadata for %s", path, exc_info=True)

    return {
        "policy_path": path,
        "policy_type": policy.type,
        "revision": revision,
        "size_bytes": size_bytes,
        "state_dim": state_dim,
        "action_dim": action_dim,
        "hardware_state_dim": hardware_state_dim,
        "hardware_action_dim": hardware_action_dim,
        "expected_visuals": sorted(expected_visuals),
        "provided_visuals": sorted(provided_visuals),
        "rename_map": rename_map,
        "supports_rtc": policy.type in {"pi0", "pi05", "pi0_fast"},
        "compatible": not issues,
        "issues": issues,
    }


def _execute_rollout(payload: dict[str, Any]) -> None:
    from lerobot.configs import PreTrainedConfig
    from lerobot.configs.dataset import DatasetRecordConfig
    from lerobot.configs.video import RGBEncoderConfig
    from lerobot.rollout.configs import (
        BaseStrategyConfig,
        DAggerStrategyConfig,
        EpisodicStrategyConfig,
        HighlightStrategyConfig,
        RolloutConfig,
        SentryStrategyConfig,
    )
    from lerobot.rollout.inference import RTCInferenceConfig, SyncInferenceConfig
    from lerobot.scripts.lerobot_rollout import rollout

    request = RolloutStartRequest.model_validate(payload)
    configuration = _configuration()
    inspection = inspect_policy_compatibility(PolicyInspectRequest(policy_path=request.policy_path))
    if not inspection["compatible"]:
        raise ValueError("Policy 与当前设备不兼容：" + "；".join(inspection["issues"]))

    needs_teleop = request.strategy in {"episodic", "dagger_corrections", "dagger_continuous"}
    robot, teleop = _decode_hardware(
        configuration,
        request.fps,
        include_teleoperator=needs_teleop,
    )
    policy_path = _policy_path(request.policy_path)
    policy = PreTrainedConfig.from_pretrained(policy_path)
    policy.pretrained_path = policy_path

    dataset = None
    if request.strategy != "base":
        dataset = DatasetRecordConfig(
            repo_id=_rollout_repo_id(request.dataset_name),
            single_task=request.task,
            fps=request.fps,
            num_episodes=request.num_episodes,
            episode_time_s=request.episode_time_s,
            reset_time_s=request.reset_time_s,
            push_to_hub=False,
            streaming_encoding=True,
            encoder_threads=2,
            encoder_queue_maxsize=30,
            rgb_encoder=RGBEncoderConfig(vcodec="h264"),
        )

    strategy = {
        "base": BaseStrategyConfig(),
        "episodic": EpisodicStrategyConfig(),
        "sentry": SentryStrategyConfig(),
        "highlight": HighlightStrategyConfig(ring_buffer_seconds=request.ring_buffer_seconds),
        "dagger_corrections": DAggerStrategyConfig(
            num_episodes=request.num_episodes,
            record_autonomous=False,
        ),
        "dagger_continuous": DAggerStrategyConfig(
            num_episodes=request.num_episodes,
            record_autonomous=True,
        ),
    }[request.strategy]
    inference = RTCInferenceConfig() if request.inference == "rtc" else SyncInferenceConfig()
    rollout(
        RolloutConfig(
            robot=robot,
            teleop=teleop if needs_teleop else None,
            policy=policy,
            strategy=strategy,
            inference=inference,
            dataset=dataset,
            fps=request.fps,
            duration=request.duration_s,
            task=request.task,
            rename_map=inspection["rename_map"],
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
    configuration = _configuration()
    if dataset.get("robot_type") and dataset["robot_type"] != configuration.robot_type:
        raise ValueError(
            f"数据集设备类型 {dataset['robot_type']} 与当前设备 {configuration.robot_type} 不一致"
        )
    if request.episode >= dataset["episodes"]:
        raise ValueError("Episode 超出数据集范围")
    robot, _ = _decode_hardware(
        configuration,
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

    def __init__(
        self,
        events: EventBroker,
        jobs: JobManager,
        collection_store: CollectionStore | None = None,
    ) -> None:
        self._events = events
        self._jobs = jobs
        self._collection_store = collection_store
        self._context = multiprocessing.get_context("spawn")
        self._lock = threading.RLock()
        self._process: multiprocessing.Process | None = None
        self._event_queue: Any = None
        self._command_queue: Any = None
        self._job_id = ""
        self._operation: Operation | None = None
        self._latest: dict[str, Any] | None = None
        self._active_dataset_id: str | None = None
        self._tracked_collection = False

    @property
    def active_dataset_id(self) -> str | None:
        with self._lock:
            return self._active_dataset_id if self._tracked_collection else None

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
        collection_task: dict[str, Any] | None = None
        if operation is Operation.RECORDING:
            if self._collection_store is None or not isinstance(request, RecordingStartRequest):
                raise RuntimeError("采集进度账本未初始化")
            collection_task = self._collection_store.require_today_task(request.task_id)
            if collection_task["collection_method"] != "manual":
                raise ValueError("该任务是 Policy 采集任务，请使用统一采集入口")
        return self._start(operation, request, collection_task)

    def start_collection(self, request: CollectionStartRequest) -> dict[str, Any]:
        if self._collection_store is None:
            raise RuntimeError("采集进度账本未初始化")
        task = self._collection_store.require_today_task(request.task_id)
        if task["collection_method"] == "manual":
            return self._start(Operation.RECORDING, RecordingStartRequest(task_id=task["id"]), task)

        local_policy = require_local_policy(task["policy_path"])
        inspection = inspect_policy_compatibility(PolicyInspectRequest(policy_path=local_policy))
        if not inspection["compatible"]:
            raise ValueError("Policy 与当前设备不兼容：" + "；".join(inspection["issues"]))
        rollout_request = RolloutStartRequest(
            policy_path=local_policy,
            strategy=task["rollout_strategy"],
            inference=task["inference"],
            task=task["description"],
            dataset_name=_recording_dataset_name(task),
            fps=task["fps"],
            duration_s=task["duration_s"],
            num_episodes=task["num_episodes"],
            episode_time_s=task["episode_time_s"],
            reset_time_s=task["reset_time_s"],
            ring_buffer_seconds=task["ring_buffer_seconds"],
        )
        return self._start(Operation.ROLLOUT, rollout_request, task)

    def _start(
        self,
        operation: Operation,
        request: BaseModel,
        collection_task: dict[str, Any] | None,
    ) -> dict[str, Any]:
        payload = request.model_dump()
        if operation is Operation.RECORDING and collection_task is not None:
            payload.update(
                {
                    "fps": collection_task["fps"],
                    "num_episodes": collection_task["num_episodes"],
                    "episode_time_s": collection_task["episode_time_s"],
                    "reset_time_s": collection_task["reset_time_s"],
                }
            )
            payload["_task_description"] = collection_task["description"]
            payload["_dataset_name"] = _recording_dataset_name(collection_task)
        job = self._jobs.acquire(operation, f"正在启动 {operation.value}")
        if collection_task is not None:
            try:
                execution_request: RecordingExecutionRequest | RolloutStartRequest
                if operation is Operation.RECORDING:
                    execution_request = RecordingExecutionRequest.model_validate(
                        {key: value for key, value in payload.items() if not key.startswith("_")}
                    )
                    dataset_name = payload["_dataset_name"]
                else:
                    execution_request = RolloutStartRequest.model_validate(payload)
                    dataset_name = execution_request.dataset_name
                self._collection_store.start_session(
                    job.id,
                    collection_task["id"],
                    dataset_name,
                    execution_request,
                )
            except Exception:
                self._jobs.release(job.id, failed=True, message="采集任务启动失败")
                raise
        event_queue = self._context.Queue()
        command_queue = self._context.Queue()
        process = self._context.Process(
            target=_run_workflow,
            args=(operation.value, payload, event_queue, command_queue),
            name=f"evomind-{operation.value}",
        )
        with self._lock:
            self._process = process
            self._event_queue = event_queue
            self._command_queue = command_queue
            self._job_id = job.id
            self._operation = operation
            self._tracked_collection = collection_task is not None
            self._latest = self._events.latest.as_dict()
        try:
            process.start()
        except Exception:
            self._clear()
            if collection_task is not None and self._collection_store is not None:
                self._collection_store.finish_session(job.id, failed=True, error="运行任务启动失败")
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
        recording_commands = {"finish_episode", "rerecord_episode"}
        rollout_commands = recording_commands | {"pause_resume", "correction", "toggle_highlight"}
        if command != "stop" and operation is Operation.RECORDING and command not in recording_commands:
            raise ValueError("当前采集任务不支持这个操作")
        if command != "stop" and operation is Operation.ROLLOUT and command not in rollout_commands:
            raise ValueError("当前 Rollout 不支持这个操作")
        if command != "stop" and operation not in {Operation.RECORDING, Operation.ROLLOUT}:
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
                tracked_collection = self._tracked_collection
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
            if tracked_collection and operation is Operation.ROLLOUT:
                message = {
                    "starting": "正在加载采集 Policy",
                    "connecting": "正在连接 Policy 采集设备",
                    "running": "Policy 数据采集中",
                    "stopping": "正在停止 Policy 采集",
                    "completed": "Policy 采集已结束",
                }.get(item["phase"], message)
            event = self._events.publish(
                Operation(item["operation"]),
                phase,
                message,
                job_id=job_id,
                data=item["data"],
            )
            if tracked_collection and self._collection_store is not None:
                try:
                    data = item["data"]
                    if data.get("repo_id"):
                        with self._lock:
                            self._active_dataset_id = str(data["repo_id"])
                    self._collection_store.update_session_repo_id(job_id, data.get("repo_id"))
                    if data.get("stage") == "episode_saved":
                        self._collection_store.save_episode(job_id, data)
                except (CollectionStoreError, KeyError, TypeError, ValueError, sqlite3.Error):
                    logging.exception("Failed to persist collection progress")
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
        if tracked_collection and self._collection_store is not None:
            self._collection_store.finish_session(job_id, failed=bool(error), error=error)
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
            self._active_dataset_id = None
            self._tracked_collection = False


__all__ = [
    "HardwareBusyError",
    "CollectionStartRequest",
    "PolicyInspectRequest",
    "RecordingStartRequest",
    "ReplayStartRequest",
    "RolloutStartRequest",
    "RuntimeCommandRequest",
    "RuntimeService",
    "TeleoperationStartRequest",
    "inspect_policy_compatibility",
    "require_local_policy",
]
