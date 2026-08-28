from evomind_lerobot.device_config import (
    CameraBinding,
    CameraSlot,
    CanBinding,
    DeviceConfiguration,
    SerialBinding,
)
from evomind_lerobot.runtime_service import (
    RolloutStartRequest,
    _camera_rename_map,
    _configured_vector_dimensions,
    _configured_visual_features,
    _policy_path,
    _robot_payload,
    _rollout_repo_id,
)


def _bi_so_configuration() -> DeviceConfiguration:
    return DeviceConfiguration(
        profile_id="bi_so",
        robot_type="bi_so_follower",
        teleoperator_type="bi_so_leader",
        camera_slots=[
            CameraSlot(alias="left_wrist", kind="wrist", side="left"),
            CameraSlot(alias="right_wrist", kind="wrist", side="right"),
            CameraSlot(alias="environment_1", kind="environment", side="single"),
        ],
        serial_bindings=[
            SerialBinding(id="left", port="/dev/left", alias="left_follower", kind="robot", side="left"),
            SerialBinding(id="right", port="/dev/right", alias="right_follower", kind="robot", side="right"),
        ],
        camera_bindings=[
            CameraBinding(
                id="left_cam",
                port="/dev/video-left",
                alias="left_wrist",
                side="left",
                driver="opencv",
                serial_number=None,
            ),
            CameraBinding(
                id="right_cam",
                port="/dev/video-right",
                alias="right_wrist",
                side="right",
                driver="opencv",
                serial_number=None,
            ),
            CameraBinding(
                id="front_cam",
                port="/dev/video-front",
                alias="environment_1",
                side="single",
                driver="opencv",
                serial_number=None,
            ),
        ],
    )


def test_policy_path_accepts_hugging_face_url() -> None:
    assert (
        _policy_path("https://huggingface.co/Elvinky/pi05_full_mix_562ep_sft_fp32")
        == "Elvinky/pi05_full_mix_562ep_sft_fp32"
    )


def test_rollout_repo_id_adds_required_prefix() -> None:
    assert _rollout_repo_id("example") == "rollout_example"
    assert _rollout_repo_id("owner/example") == "owner/rollout_example"
    assert _rollout_repo_id("owner/rollout_example") == "owner/rollout_example"


def test_dual_arm_environment_camera_is_top_level() -> None:
    payload = _robot_payload(_bi_so_configuration(), 30, cameras=True)

    assert set(payload["left_arm_config"]["cameras"]) == {"wrist"}
    assert set(payload["right_arm_config"]["cameras"]) == {"wrist"}
    assert set(payload["cameras"]) == {"environment_1"}


def test_piper_environment_camera_stays_on_right_arm() -> None:
    configuration = DeviceConfiguration(
        profile_id="bi_piperx",
        robot_type="bi_piperx_follower",
        camera_slots=[CameraSlot(alias="environment_1", kind="environment", side="single")],
        can_bindings=[
            CanBinding(id="can-left", alias="left_follower", kind="robot", side="left"),
            CanBinding(id="can-right", alias="right_follower", kind="robot", side="right"),
        ],
        camera_bindings=[
            CameraBinding(
                id="front_cam",
                port="/dev/video-front",
                alias="environment_1",
                side="single",
                driver="opencv",
                serial_number=None,
            )
        ],
    )

    payload = _robot_payload(configuration, 30, cameras=True)

    assert "cameras" not in payload
    assert set(payload["right_arm_config"]["cameras"]) == {"environment_1"}


def test_pi05_camera_mapping_and_vector_dimensions() -> None:
    configuration = _bi_so_configuration()
    provided = _configured_visual_features(configuration)
    expected = {
        "observation.images.left_wrist",
        "observation.images.right_wrist",
        "observation.images.right_front",
    }

    assert _configured_vector_dimensions(configuration) == (12, 12)
    assert _camera_rename_map(configuration, expected, provided) == {
        "observation.images.environment_1": "observation.images.right_front"
    }


def test_rollout_request_exposes_all_web_modes() -> None:
    for strategy in (
        "base",
        "episodic",
        "sentry",
        "highlight",
        "dagger_corrections",
        "dagger_continuous",
    ):
        request = RolloutStartRequest(policy_path="model", strategy=strategy, task="task")
        assert request.strategy == strategy
