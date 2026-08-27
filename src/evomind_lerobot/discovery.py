"""Read-only local hardware inventory."""

from __future__ import annotations

import os
import re
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


def _socketcan_devices() -> list[dict[str, Any]]:
    devices = []
    network_root = Path("/sys/class/net")
    if not network_root.exists():
        return devices
    for path in sorted(network_root.iterdir()):
        try:
            if (path / "type").read_text().strip() != "280":
                continue
        except OSError:
            continue
        properties = subprocess.run(
            ["udevadm", "info", "--query=property", f"--path={path}"],
            capture_output=True,
            text=True,
            check=False,
        ).stdout.splitlines()
        serial_number = next(
            (
                line.removeprefix("ID_SERIAL_SHORT=")
                for line in properties
                if line.startswith("ID_SERIAL_SHORT=")
            ),
            "",
        )
        device_path = next(
            (
                line.removeprefix("ID_PATH=")
                for line in properties
                if line.startswith("ID_PATH=")
            ),
            "",
        )
        # Identification must include every SocketCAN interface.  Prefer the
        # adapter serial for a reboot-stable identity, then the physical USB
        # path, and only fall back to the current interface name when udev has
        # neither property (for example, a virtual CAN interface).
        stable_id = serial_number or device_path or path.name
        detail = subprocess.run(
            ["ip", "-details", "link", "show", path.name],
            capture_output=True,
            text=True,
            check=False,
        ).stdout
        bitrate_match = re.search(r"\bbitrate\s+(\d+)", detail)
        flags_match = re.search(r"<([^>]+)>", detail)
        flags = set(flags_match.group(1).split(",")) if flags_match else set()
        devices.append(
            {
                "id": stable_id,
                "serial_number": serial_number,
                "interface": path.name,
                "state": (path / "operstate").read_text().strip(),
                "up": "UP" in flags,
                "bitrate": int(bitrate_match.group(1)) if bitrate_match else None,
            }
        )
    return devices


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
        # A single physical camera may expose video nodes from several USB
        # interfaces (for example, RealSense depth and RGB endpoints). Group
        # those interfaces by their nearest USB device parent instead of
        # presenting them as separate cameras.
        usb_device = next(
            (
                candidate
                for candidate in (device_path, *device_path.parents)
                if (candidate / "idVendor").exists() and (candidate / "idProduct").exists()
            ),
            device_path,
        )
        key = str(usb_device)
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
        "socketcan": _socketcan_devices(),
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
