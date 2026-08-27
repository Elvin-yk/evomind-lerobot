"""Configure classic 1 Mbit/s SocketCAN interfaces for PiperX."""

from __future__ import annotations

import argparse
import subprocess
from pathlib import Path


def can_interfaces() -> list[str]:
    interfaces = []
    for path in sorted(Path("/sys/class/net").iterdir()):
        try:
            if (path / "type").read_text().strip() == "280":
                interfaces.append(path.name)
        except OSError:
            continue
    return interfaces


def configure(interface: str) -> None:
    subprocess.run(["ip", "link", "set", interface, "down"], check=False)
    subprocess.run(
        ["ip", "link", "set", interface, "type", "can", "bitrate", "1000000"],
        check=True,
    )
    subprocess.run(["ip", "link", "set", interface, "up"], check=True)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("interfaces", nargs="*", help="默认配置检测到的全部 SocketCAN 接口")
    arguments = parser.parse_args()
    selected = arguments.interfaces or can_interfaces()
    if not selected:
        raise SystemExit("未发现 SocketCAN 接口")
    for interface in selected:
        configure(interface)
        print(f"configured {interface}: classic CAN 1000000 bit/s")
