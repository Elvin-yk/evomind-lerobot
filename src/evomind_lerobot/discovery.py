"""Read-only local hardware inventory."""

from __future__ import annotations

import os
import shutil
import subprocess
import sys
from importlib.metadata import PackageNotFoundError, version
from pathlib import Path
from typing import Any


def _serial_devices() -> list[dict[str, str]]:
    root = Path("/dev/serial/by-id")
    if not root.exists():
        return []
    return [
        {
            "id": path.name,
            "path": str(path),
            "device": str(path.resolve()),
        }
        for path in sorted(root.iterdir())
        if path.is_symlink()
    ]


def _video_devices() -> list[dict[str, str]]:
    devices = []
    for path in sorted(Path("/dev").glob("video*")):
        name_path = Path("/sys/class/video4linux") / path.name / "name"
        name = name_path.read_text().strip() if name_path.exists() else path.name
        devices.append({"id": path.name, "path": str(path), "name": name})
    return devices


def _video_aliases() -> tuple[dict[str, str], dict[str, str]]:
    aliases = []
    for directory in (Path("/dev/v4l/by-id"), Path("/dev/v4l/by-path")):
        aliases.append(
            {
                str(path.resolve()): str(path)
                for path in sorted(directory.iterdir())
                if path.is_symlink()
            }
            if directory.exists()
            else {}
        )
    return aliases[0], aliases[1]


def _camera_devices(video_devices: list[dict[str, str]]) -> list[dict[str, Any]]:
    by_id, by_path = _video_aliases()
    cameras: dict[str, dict[str, Any]] = {}
    for video in video_devices:
        device_path = (Path("/sys/class/video4linux") / video["id"] / "device").resolve()
        key = str(device_path)
        resolved_video = str(Path(video["path"]).resolve())
        stable_path = by_id.get(resolved_video) or by_path.get(resolved_video) or video["path"]
        camera = cameras.setdefault(
            key,
            {
                "id": stable_path,
                "name": video["name"],
                "path": stable_path,
                "paths": [],
            },
        )
        camera["paths"].append(video["path"])
    return list(cameras.values())


def hardware_inventory() -> dict[str, Any]:
    video_devices = _video_devices()
    return {
        "serial": _serial_devices(),
        "video": video_devices,
        "cameras": _camera_devices(video_devices),
        "platform": os.uname().sysname,
        "hostname": os.uname().nodename,
    }


def _package_version(name: str) -> str | None:
    try:
        return version(name)
    except PackageNotFoundError:
        return None


def _gpu_name() -> str | None:
    try:
        result = subprocess.run(
            ["nvidia-smi", "--query-gpu=name", "--format=csv,noheader"],
            check=True,
            capture_output=True,
            text=True,
            timeout=2,
        )
    except (FileNotFoundError, subprocess.CalledProcessError, subprocess.TimeoutExpired):
        return None
    return result.stdout.splitlines()[0].strip() or None


def runtime_inventory() -> dict[str, Any]:
    data_root = Path(os.environ.get("HF_LEROBOT_HOME", Path.home() / ".cache/huggingface/lerobot"))
    existing_root = data_root if data_root.exists() else Path.home()
    disk = shutil.disk_usage(existing_root)
    return {
        "hostname": os.uname().nodename,
        "python_version": ".".join(str(part) for part in sys.version_info[:3]),
        "lerobot_version": _package_version("lerobot"),
        "torch_version": _package_version("torch"),
        "gpu": _gpu_name(),
        "data_root": str(data_root),
        "disk_free_bytes": disk.free,
        "disk_total_bytes": disk.total,
    }
