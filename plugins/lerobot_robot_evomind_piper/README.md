# Evomind PiperX LeRobot plugin

This package adds single-arm and bimanual PiperX robots to LeRobot through its
third-party hardware plugin discovery mechanism. It registers
`piperx_follower`, `piperx_leader`, `bi_piperx_follower`, and
`bi_piperx_leader` without modifying LeRobot's built-in robot registry.

USB-CAN adapters are stored by their udev `ID_SERIAL_SHORT`. The current
SocketCAN interface name is resolved when a robot connects, so `can0`/`can1`
renumbering after a reboot does not invalidate a saved device configuration.

Install the project and plugin into the same Python environment:

```bash
pip install -e '.[console,piperx]'
pip install -e plugins/lerobot_robot_evomind_piper
```

Configure all detected adapters as classic CAN at 1 Mbit/s before starting the
console:

```bash
sudo lerobot-piper-setup-can
```

The protocol behavior is based on the PiperX support in
[Evo-RL](https://github.com/MINT-SJTU/Evo-RL) and the conservative role-switch,
firmware, and enable checks used by EvoStudio Client.
