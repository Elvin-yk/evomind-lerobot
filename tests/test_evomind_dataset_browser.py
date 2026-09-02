import json

from evomind_lerobot.dataset_browser import _control_breakdown, _dataset_provenance


def test_dataset_provenance_reads_explicit_metadata(tmp_path) -> None:
    metadata = tmp_path / "meta"
    metadata.mkdir()
    (metadata / "evomind.json").write_text(
        json.dumps(
            {
                "schema_version": 1,
                "collection_method": "policy",
                "control_source": "mixed",
                "rollout_strategy": "dagger_continuous",
                "inference": "rtc",
                "policy": {"path": "/models/example", "type": "pi05"},
            }
        ),
        encoding="utf-8",
    )

    result = _dataset_provenance(tmp_path, {})

    assert result["declared"] is True
    assert result["control_source"] == "mixed"
    assert result["rollout_strategy"] == "dagger_continuous"
    assert result["policy"] == {"path": "/models/example", "type": "pi05"}


def test_dataset_provenance_recognizes_legacy_dagger_data(tmp_path) -> None:
    result = _dataset_provenance(tmp_path, {"intervention": {"dtype": "bool"}})

    assert result == {
        "collection_method": "policy",
        "control_source": "mixed",
        "rollout_strategy": "dagger",
        "inference": None,
        "policy": None,
        "declared": False,
    }


def test_dataset_provenance_keeps_unlabelled_legacy_data_unknown(tmp_path) -> None:
    result = _dataset_provenance(tmp_path, {})

    assert result["control_source"] == "unknown"
    assert result["declared"] is False


def test_control_breakdown_builds_dagger_segments() -> None:
    result = _control_breakdown(
        5,
        2,
        {"control_source": "mixed"},
        [[False], [False], [True], [True], [False]],
    )

    assert result["mode"] == "mixed"
    assert result["policy_frames"] == 3
    assert result["intervention_frames"] == 2
    assert result["unknown_frames"] == 0
    assert result["segments"] == [
        {"source": "policy", "start_s": 0, "end_s": 1, "frames": 2},
        {"source": "human_intervention", "start_s": 1, "end_s": 2, "frames": 2},
        {"source": "policy", "start_s": 2, "end_s": 2.5, "frames": 1},
    ]


def test_control_breakdown_uses_dataset_source_without_frame_labels() -> None:
    result = _control_breakdown(3, 30, {"control_source": "human_demonstration"}, None)

    assert result["mode"] == "human_demonstration"
    assert result["demonstration_frames"] == 3
    assert result["segments"][0]["source"] == "human_demonstration"


def test_control_breakdown_handles_empty_episode() -> None:
    result = _control_breakdown(0, 30, {"control_source": "mixed"}, [])

    assert result["mode"] == "unknown"
    assert result["unknown_frames"] == 0
    assert result["segments"] == []
