# EvoStudio Runtime Agent Guide

This repository is a thin, updateable fork of Hugging Face LeRobot. The EvoStudio-specific rules in this section take precedence over the inherited LeRobot guidance below.

## Required Context

Before making changes, read [`README.md`](./README.md) and [`UPSTREAM.md`](./UPSTREAM.md). Preserve the current upstream base and inspect existing implementations before adding code.

## Repository Boundaries

- `origin` (JiHuLab) is the only push target. `upstream` (GitHub) is read-only. Never push to GitHub or trigger GitHub Actions.
- Keep a single repository. Do not introduce another Engine repository, a LeRobot source submodule, vendored ROS source, or a dependency redirect to a sibling checkout.
- Put Studio protocol, supervision, events, installation integration, and other product logic under `src/evostudio_runtime/`.
- Put EvoStudio robot and teleoperator implementations in isolated LeRobot extension namespaces rather than scattering embodiment checks through rollout code.
- Treat `src/lerobot/` as upstream-owned. Modify it only for a generic fix or Hook that cannot be implemented through an existing public extension point.
- `src/lerobot/` must not depend on EvoStudio Cloud/Web APIs or embodiment-specific business objects.

## Core Modification Rules

Any change under `src/lerobot/` must:

1. Preserve official behavior when the new Hook is not configured.
2. Use generic LeRobot terminology rather than EvoStudio-specific names.
3. Be isolated in a reviewable commit without unrelated product changes or formatting churn.
4. Be recorded in the core-difference table in `UPSTREAM.md`.
5. Prefer a patch that could reasonably be contributed upstream.

Before handoff, compare the fork against the recorded upstream Tag:

```bash
git diff v0.6.1 -- src/lerobot
```

Update the Tag in this command when `UPSTREAM.md` changes. Any unrecorded core difference is a release blocker.

## Runtime Rules

- Use native LeRobot Dataset, rollout, policy, robot, teleoperation, and logging behavior whenever it exists; do not reimplement it in EvoStudio.
- Emit Studio state through a structured event interface. Never parse stdout/stderr as a state protocol.
- LeRobot Runtime is the sole hardware owner while an operation is active. A supervisor may control the process but must not open the same robot or camera.
- Keep the official Dataset schema by default. Schema extensions require an explicit product requirement and compatibility review.
- Do not add compatibility shims, deprecated wrappers, silent fallbacks, or broad exception swallowing. Fix the current source of truth.
- Keep the existing production `evostudio-client` untouched until the new Runtime passes migration and real-hardware acceptance.

## Upstream And Validation Policy

- Follow stable LeRobot Tags through explicit upgrade branches; do not continuously merge arbitrary `upstream/main` commits.
- Do not configure daily or weekly compatibility CI. Run checks only for deliberate upgrades and releases.
- Reuse existing LeRobot tests first. Do not add tests speculatively during repository initialization.
- Hardware-facing releases require real-device validation for every embodiment claimed as supported.
- Do not mix an upstream merge with new EvoStudio feature work in the same commit.

## Inherited LeRobot Guidance

The remainder of this file is the guidance inherited from the current LeRobot baseline and still applies unless it conflicts with the EvoStudio rules above.

This file provides guidance to AI agents when working with code in this repository.

> **User-facing help → [`AGENT_GUIDE.md`](./AGENT_GUIDE.md)** (SO-101 setup, recording, picking a policy, training duration, eval — with copy-pasteable commands).

## Project Overview

LeRobot is a PyTorch-based library for real-world robotics, providing datasets, pretrained policies, and tools for training, evaluation, data collection, and robot control. It integrates with Hugging Face Hub for model/dataset sharing.

## Tech Stack

Python 3.12+ · PyTorch · Hugging Face (datasets, Hub, accelerate) · draccus (config/CLI) · Gymnasium (envs) · uv (package management)

## Development Setup

```bash
uv sync --locked                            # Base dependencies
uv sync --locked --extra test --extra dev   # Test + dev tools
uv sync --locked --extra all                # Everything
git lfs install && git lfs pull             # Test artifacts
```

## Key Commands

```bash
uv run pytest tests -svv --maxfail=10                 # All tests
DEVICE=cuda make test-end-to-end                      # All E2E tests
pre-commit run --all-files                           # Lint + format (ruff, typos, bandit, etc.)
```

## Architecture (`src/lerobot/`)

- **`scripts/`** — CLI entry points (`lerobot-train`, `lerobot-eval`, `lerobot-record`, etc.), mapped in `pyproject.toml [project.scripts]`.
- **`configs/`** — Dataclass configs parsed by draccus. `train.py` has `TrainPipelineConfig` (top-level). `policies.py` has `PreTrainedConfig` base. Polymorphism via `draccus.ChoiceRegistry` with `@register_subclass("name")` decorators.
- **`policies/`** — Each policy in its own subdir. All inherit `PreTrainedPolicy` (`nn.Module` + `HubMixin`) from `pretrained.py`. Factory with lazy imports in `factory.py`.
- **`processor/`** — Data transformation pipeline. `ProcessorStep` base with registry. `DataProcessorPipeline` / `PolicyProcessorPipeline` chain steps.
- **`datasets/`** — `LeRobotDataset` (episode-aware sampling + video decoding) and `LeRobotDatasetMetadata`.
- **`envs/`** — `EnvConfig` base in `configs.py`, factory in `factory.py`. Each env subclass defines `gym_kwargs` and `create_envs()`.
- **`robots/`, `motors/`, `cameras/`, `teleoperators/`** — Hardware abstraction layers.
- **`types.py`** and **`configs/types.py`** — Core type aliases and feature type definitions.

## Repository Structure (outside `src/`)

- **`tests/`** — Pytest suite organized by module. Fixtures in `tests/fixtures/`, mocks in `tests/mocks/`. Hardware tests use skip decorators from `tests/utils.py`. E2E tests via `Makefile` write to `tests/outputs/`.
- **`.github/workflows/`** — CI: `quality.yml` (pre-commit), `fast_tests.yml` (base deps, every PR), `full_tests.yml` (all extras + E2E + GPU, post-approval), `latest_deps_tests.yml` (daily lockfile upgrade), `security.yml` (TruffleHog), `release.yml` (PyPI publish on tags).
- **`docs/source/`** — HF documentation (`.mdx` files). Per-policy READMEs, hardware guides, tutorials. Built separately via `docs-requirements.txt` and CI workflows.
- **`examples/`** — End-user tutorials and scripts organized by use case (dataset creation, training, hardware setup).
- **`docker/`** — Dockerfiles for user (`Dockerfile.user`) and CI (`Dockerfile.internal`).
- **`benchmarks/`** — Performance benchmarking scripts.
- **Root files**: `pyproject.toml` (single source of truth for deps, build, tool config), `Makefile` (E2E test targets), `uv.lock`, `CONTRIBUTING.md` & `README.md` (general information).

## Notes

- **Mypy is gradual**: strict only for `lerobot.envs`, `lerobot.configs`, `lerobot.optim`, `lerobot.model`, `lerobot.cameras`, `lerobot.motors`, `lerobot.transport`. Add type annotations when modifying these modules.
- **Imports**: prefer top-level imports; relative (`from .sibling import X`) across sibling files within a module, absolute (`from lerobot.module import X`) across modules.
- **Optional dependencies**: many policies, envs, and robots are behind extras (e.g., `lerobot[aloha]`, see `pyproject.toml`). Guard optional imports with `TYPE_CHECKING or _foo_available` at module top + a `require_package(...)` check at use time. Reuse the `_foo_available` flags in `utils/import_utils.py`; don't call `is_package_available`.
- **Video decoding**: datasets can store observations as video files. `LeRobotDataset` handles frame extraction, but tests need ffmpeg installed.
- **Prioritize use of `uv run`** to execute Python commands (not raw `python` or `pip`).
