"""FastAPI application for the local LeRobot console."""

from __future__ import annotations

import asyncio
import os
from importlib.metadata import PackageNotFoundError, version
from pathlib import Path

try:
    from fastapi import FastAPI, HTTPException, WebSocket, WebSocketDisconnect
    from fastapi.middleware.cors import CORSMiddleware
    from fastapi.staticfiles import StaticFiles
except ImportError as error:
    raise ImportError("Install the local console with `pip install 'lerobot[console]'`") from error

from pydantic import BaseModel, Field

from evomind_lerobot.calibration_service import CalibrationService
from evomind_lerobot.catalog import hardware_catalog
from evomind_lerobot.device_config import (
    DeviceConfiguration,
    load_device_configuration,
    save_device_configuration,
)
from evomind_lerobot.discovery import hardware_inventory, runtime_inventory
from evomind_lerobot.events import EventBroker, Operation, Phase
from evomind_lerobot.feetech_service import (
    FeetechActionRequest,
    FeetechScanRequest,
    FeetechSnapshotRequest,
    run_feetech_action,
    scan_feetech,
    snapshot_feetech,
)
from evomind_lerobot.identification import (
    camera_previews,
    poll_motion_identification,
    start_motion_identification,
    stop_motion_identification,
)
from evomind_lerobot.jobs import JobManager
from evomind_lerobot.runtime_service import (
    HardwareBusyError,
    RecordingStartRequest,
    ReplayStartRequest,
    RolloutStartRequest,
    RuntimeCommandRequest,
    RuntimeService,
    TeleoperationStartRequest,
)
from evomind_lerobot.workspace import workspace_inventory


class MotionStartRequest(BaseModel):
    model: str = Field(min_length=1)
    excluded_ids: list[str] = Field(default_factory=list)


class CalibrationStartRequest(BaseModel):
    alias: str = Field(min_length=1)


class CalibrationAutoStartRequest(BaseModel):
    alias: str | None = Field(default=None, min_length=1)


def _package_version(name: str) -> str | None:
    try:
        return version(name)
    except PackageNotFoundError:
        return None


def create_app():
    events = EventBroker()
    jobs = JobManager(events)
    calibration = CalibrationService(events, jobs)
    runtime = RuntimeService(events, jobs)
    app = FastAPI(title="Evomind LeRobot Console", version="0.1.0")
    app.state.events = events
    app.state.jobs = jobs
    app.state.calibration = calibration
    app.state.runtime = runtime
    app.add_middleware(
        CORSMiddleware,
        allow_origins=[
            "http://127.0.0.1:3000",
            "http://localhost:3000",
            "http://127.0.0.1:3001",
            "http://localhost:3001",
        ],
        allow_methods=["GET"],
        allow_headers=["*"],
    )

    @app.get("/api/status")
    def status():
        current = jobs.current
        return {
            "ready": True,
            "lerobot_version": _package_version("lerobot"),
            "runtime": runtime_inventory(),
            "current_job": current.as_dict() if current else None,
            "event": events.latest.as_dict(),
        }

    @app.get("/api/devices")
    def devices():
        return hardware_inventory()

    @app.get("/api/catalog")
    def catalog():
        return hardware_catalog()

    @app.get("/api/workspace")
    def workspace():
        return workspace_inventory()

    @app.get("/api/config")
    def read_configuration():
        configuration = load_device_configuration()
        return configuration.model_dump() if configuration else None

    @app.put("/api/config")
    def write_configuration(configuration: DeviceConfiguration):
        if jobs.current is not None:
            raise HTTPException(409, "硬件任务运行中，不能修改设备配置")
        catalog_data = hardware_catalog()
        profiles = {profile["id"]: profile for profile in catalog_data["systems"]}
        profile = profiles.get(configuration.profile_id)
        if profile is None:
            raise HTTPException(400, f"Unknown device profile: {configuration.profile_id}")
        if configuration.robot_type != profile["robot_type"]:
            raise HTTPException(400, "Robot type does not match the selected device profile")
        if configuration.teleoperator_type != profile["teleoperator_type"]:
            raise HTTPException(400, "Teleoperator type does not match the selected device profile")

        robot_bindings = [binding for binding in configuration.serial_bindings if binding.kind == "robot"]
        teleoperator_bindings = [
            binding for binding in configuration.serial_bindings if binding.kind == "teleoperator"
        ]
        if (
            robot_bindings
            and profile["robot_ports"] is not None
            and len(robot_bindings) != profile["robot_ports"]
        ):
            raise HTTPException(400, f"This device requires {profile['robot_ports']} robot ports")
        if (
            teleoperator_bindings
            and profile["teleoperator_ports"] is not None
            and len(teleoperator_bindings) != profile["teleoperator_ports"]
        ):
            raise HTTPException(
                400,
                f"This device requires {profile['teleoperator_ports']} teleoperator ports",
            )

        inventory = hardware_inventory()
        serial_devices = {device["id"]: device for device in inventory["serial"]}
        camera_devices = {device["id"]: device for device in inventory["cameras"]}
        for binding in configuration.serial_bindings:
            device = serial_devices.get(binding.id)
            if device is None or binding.port != device["path"]:
                raise HTTPException(400, f"Serial device is no longer connected: {binding.id}")
        for binding in configuration.camera_bindings:
            device = camera_devices.get(binding.id)
            if device is None or binding.port != device["path"]:
                raise HTTPException(400, f"Camera is no longer connected: {binding.id}")

        save_device_configuration(configuration)
        return configuration.model_dump()

    @app.post("/api/maintenance/feetech/scan")
    async def scan_feetech_servos(body: FeetechScanRequest):
        events.publish(Operation.DIAGNOSTICS, Phase.STARTING, "正在扫描飞特舵机")
        try:
            result = await asyncio.to_thread(scan_feetech, body)
        except (ConnectionError, OSError, RuntimeError, ValueError) as error:
            events.publish(Operation.DIAGNOSTICS, Phase.FAILED, str(error))
            raise HTTPException(400, str(error)) from error
        events.publish(
            Operation.DIAGNOSTICS,
            Phase.COMPLETED,
            f"发现 {len(result['motors'])} 个飞特舵机",
            data={"device_id": body.device_id, "motor_count": len(result["motors"])},
        )
        return result

    @app.post("/api/maintenance/feetech/action")
    async def control_feetech_servo(body: FeetechActionRequest):
        events.publish(
            Operation.DIAGNOSTICS,
            Phase.RUNNING,
            f"执行舵机操作：{body.action}",
            data={"device_id": body.device_id, "motor_id": body.motor_id},
        )
        try:
            result = await asyncio.to_thread(run_feetech_action, body)
        except (ConnectionError, OSError, RuntimeError, ValueError) as error:
            events.publish(Operation.DIAGNOSTICS, Phase.FAILED, str(error))
            raise HTTPException(400, str(error)) from error
        events.publish(Operation.DIAGNOSTICS, Phase.COMPLETED, "舵机操作完成")
        return result

    @app.post("/api/maintenance/feetech/snapshot")
    async def snapshot_feetech_servos(body: FeetechSnapshotRequest):
        try:
            return await asyncio.to_thread(snapshot_feetech, body)
        except (ConnectionError, OSError, RuntimeError, ValueError) as error:
            raise HTTPException(400, str(error)) from error

    @app.get("/api/calibration/status")
    def calibration_status():
        return calibration.status()

    @app.post("/api/calibration/auto/start")
    def calibration_auto_start(body: CalibrationAutoStartRequest):
        try:
            return calibration.start_auto(body.alias)
        except (RuntimeError, ValueError) as error:
            raise HTTPException(409, str(error)) from error

    @app.post("/api/calibration/manual/start")
    def calibration_manual_start(body: CalibrationStartRequest):
        try:
            return calibration.start_manual(body.alias)
        except (RuntimeError, ValueError) as error:
            raise HTTPException(409, str(error)) from error

    @app.post("/api/calibration/manual/advance")
    def calibration_manual_advance():
        try:
            return calibration.advance_manual()
        except RuntimeError as error:
            raise HTTPException(409, str(error)) from error

    @app.get("/api/runtime/status")
    def runtime_status():
        return runtime.status()

    @app.post("/api/runtime/teleoperation/start")
    def runtime_teleoperation_start(body: TeleoperationStartRequest):
        try:
            return runtime.start(Operation.TELEOPERATION, body)
        except HardwareBusyError as error:
            raise HTTPException(409, str(error)) from error

    @app.post("/api/runtime/recording/start")
    def runtime_recording_start(body: RecordingStartRequest):
        try:
            return runtime.start(Operation.RECORDING, body)
        except HardwareBusyError as error:
            raise HTTPException(409, str(error)) from error

    @app.post("/api/runtime/rollout/start")
    def runtime_rollout_start(body: RolloutStartRequest):
        try:
            return runtime.start(Operation.ROLLOUT, body)
        except HardwareBusyError as error:
            raise HTTPException(409, str(error)) from error

    @app.post("/api/runtime/replay/start")
    def runtime_replay_start(body: ReplayStartRequest):
        try:
            return runtime.start(Operation.REPLAY, body)
        except HardwareBusyError as error:
            raise HTTPException(409, str(error)) from error

    @app.post("/api/runtime/command")
    def runtime_command(body: RuntimeCommandRequest):
        try:
            return runtime.command(body.command)
        except (RuntimeError, ValueError) as error:
            raise HTTPException(409, str(error)) from error

    @app.post("/api/calibration/stop")
    def calibration_stop():
        try:
            return calibration.stop()
        except RuntimeError as error:
            raise HTTPException(409, str(error)) from error

    @app.post("/api/identify/motion/start")
    async def identify_motion_start(body: MotionStartRequest):
        return await asyncio.to_thread(
            start_motion_identification,
            body.model,
            set(body.excluded_ids),
        )

    @app.get("/api/identify/motion/poll")
    async def identify_motion_poll():
        try:
            return await asyncio.to_thread(poll_motion_identification)
        except RuntimeError as error:
            raise HTTPException(400, str(error)) from error

    @app.post("/api/identify/motion/stop")
    async def identify_motion_stop():
        return await asyncio.to_thread(stop_motion_identification)

    @app.post("/api/identify/cameras")
    async def identify_cameras():
        return await asyncio.to_thread(camera_previews)

    @app.websocket("/api/events")
    async def event_stream(websocket: WebSocket):
        await websocket.accept()
        queue = events.subscribe()
        try:
            await websocket.send_json(events.latest.as_dict())
            while True:
                event = await queue.get()
                await websocket.send_json(event.as_dict())
        except WebSocketDisconnect:
            pass
        finally:
            events.unsubscribe(queue)

    source_root = Path(__file__).resolve().parents[2]
    web_root = Path(os.environ.get("EVOMIND_LEROBOT_WEB_ROOT", source_root / "web/dist/client"))
    if web_root.joinpath("index.html").is_file():
        app.mount("/", StaticFiles(directory=web_root, html=True), name="console")

    return app


app = create_app()
