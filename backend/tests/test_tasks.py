"""R6: the unified background-task backend.

The worker loop never runs in tests (conftest disables it); every test
drives `task_worker.run_once` with the transactional test session, which
makes lifecycle behavior fully deterministic.
"""

from __future__ import annotations

import asyncio

import pytest
from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.errors import ConflictError
from app.services import task_handlers, task_lifecycle, task_service, task_worker

GEOJSON = (
    '{"type": "FeatureCollection", "features": [{"type": "Feature",'
    ' "geometry": {"type": "Point", "coordinates": [116.4, 39.9]},'
    ' "properties": {"name": "Beijing"}}]}'
)


@pytest.fixture
async def project_id(client: AsyncClient) -> str:
    return (await client.post("/api/v1/projects", json={"name": "Tasks"})).json()["id"]


def _upload(content: str, filename: str = "cities.geojson") -> dict:
    return {"file": (filename, content.encode(), "application/geo+json")}


# ---------------------------------------------------------------- lifecycle


def test_every_declared_transition_is_consistent() -> None:
    for current, targets in task_lifecycle.TRANSITIONS.items():
        for target in targets:
            assert task_lifecycle.can_transition(current, target)
        if not targets:
            assert task_lifecycle.is_terminal(current)


@pytest.mark.parametrize(
    ("current", "target"),
    [
        ("queued", "succeeded"),
        ("queued", "failed"),
        ("running", "queued"),
        ("succeeded", "running"),
        ("failed", "running"),
        ("cancelled", "cancelling"),
        ("cancelling", "running"),
    ],
)
def test_invalid_transitions_raise(current: str, target: str) -> None:
    with pytest.raises(ConflictError):
        task_lifecycle.assert_transition(current, target)


# ---------------------------------------------------------------- execution


async def test_submitted_import_executes_to_success(
    client: AsyncClient, db_session: AsyncSession, project_id: str
) -> None:
    submitted = await client.post(
        f"/api/v1/projects/{project_id}/tasks/import", files=_upload(GEOJSON)
    )
    assert submitted.status_code == 202, submitted.text
    task = submitted.json()
    assert task["state"] == "queued"
    assert task["provenance"]["sourceFilename"] == "cities.geojson"

    assert await task_worker.run_once(db_session) is True

    detail = (await client.get(f"/api/v1/tasks/{task['id']}")).json()
    assert detail["state"] == "succeeded"
    assert detail["progress"] == 1.0
    assert detail["stage"] == "completed"
    assert detail["result"]["featureCount"] == 1
    assert detail["durationMs"] is not None
    assert detail["retryable"] is False  # succeeded tasks are not retried

    # The produced layer is real and linked.
    layer = (await client.get(f"/api/v1/layers/{detail['result']['layerId']}")).json()
    assert layer["name"] == "cities"
    assert detail["layerId"] == layer["id"]

    # Logs recorded real stages, result endpoint serves the result.
    logs = (await client.get(f"/api/v1/tasks/{task['id']}/logs")).json()
    messages = [entry["message"] for entry in logs["entries"]]
    assert any("reading" in message for message in messages)
    assert any("succeeded" in message for message in messages)
    result = await client.get(f"/api/v1/tasks/{task['id']}/result")
    assert result.status_code == 200
    assert result.json()["featureCount"] == 1


async def test_failure_stores_a_structured_actionable_error(
    client: AsyncClient, db_session: AsyncSession, project_id: str
) -> None:
    submitted = await client.post(
        f"/api/v1/projects/{project_id}/tasks/import",
        files=_upload("{this is not geojson", "broken.geojson"),
    )
    task_id = submitted.json()["id"]
    await task_worker.run_once(db_session)

    detail = (await client.get(f"/api/v1/tasks/{task_id}")).json()
    assert detail["state"] == "failed"
    assert detail["error"]["code"]
    assert detail["error"]["message"]
    assert detail["retryable"] is True  # the upload is kept for retry

    result = await client.get(f"/api/v1/tasks/{task_id}/result")
    assert result.status_code == 409


async def test_unknown_kind_fails_without_killing_the_worker(
    client: AsyncClient, db_session: AsyncSession, project_id: str
) -> None:
    import uuid as uuid_module

    task = await task_service.create_task(
        db_session,
        project_id=uuid_module.UUID(project_id),
        kind="not_a_registered_kind",
        params={},
    )
    assert await task_worker.run_once(db_session) is True
    refreshed = (await client.get(f"/api/v1/tasks/{task.id}")).json()
    assert refreshed["state"] == "failed"
    assert refreshed["error"]["code"] == "invalid_request"


# ------------------------------------------------------------- cancellation


async def test_cancel_before_start_is_immediate(client: AsyncClient, project_id: str) -> None:
    task = (
        await client.post(f"/api/v1/projects/{project_id}/tasks/import", files=_upload(GEOJSON))
    ).json()
    cancelled = await client.post(f"/api/v1/tasks/{task['id']}/cancel")
    assert cancelled.status_code == 202
    assert cancelled.json()["state"] == "cancelled"
    assert cancelled.json()["finishedAt"] is not None

    # Terminal tasks reject further cancellation: the invalid transition
    # surfaces as a 409, not a silent overwrite.
    again = await client.post(f"/api/v1/tasks/{task['id']}/cancel")
    assert again.status_code == 409


async def test_running_task_cancels_cooperatively(
    client: AsyncClient, db_session: AsyncSession, project_id: str
) -> None:
    import uuid as uuid_module

    started = asyncio.Event()
    release = asyncio.Event()

    @task_handlers.register("test_cancellable")
    async def _handler(ctx: task_handlers.TaskContext) -> dict:
        await ctx.report(0.3, "working")
        started.set()
        await release.wait()
        await ctx.check_cancelled()  # the cooperative checkpoint
        return {"unreachable": True}

    try:
        task = await task_service.create_task(
            db_session,
            project_id=uuid_module.UUID(project_id),
            kind="test_cancellable",
            params={"anything": 1},
        )
        runner = asyncio.create_task(task_worker.run_once(db_session))
        await asyncio.wait_for(started.wait(), timeout=5)

        response = await client.post(f"/api/v1/tasks/{task.id}/cancel")
        assert response.json()["state"] == "cancelling"

        release.set()
        assert await asyncio.wait_for(runner, timeout=5) is True

        final = (await client.get(f"/api/v1/tasks/{task.id}")).json()
        assert final["state"] == "cancelled"
        assert final["cancelRequested"] is True
        assert final["finishedAt"] is not None
    finally:
        task_handlers._REGISTRY.pop("test_cancellable", None)


# -------------------------------------------------------------------- retry


async def test_retry_creates_a_traceable_new_execution(
    client: AsyncClient, db_session: AsyncSession, project_id: str
) -> None:
    submitted = await client.post(
        f"/api/v1/projects/{project_id}/tasks/import",
        files=_upload("{broken", "broken.geojson"),
    )
    original_id = submitted.json()["id"]
    await task_worker.run_once(db_session)

    retried = await client.post(f"/api/v1/tasks/{original_id}/retry")
    assert retried.status_code == 201
    fresh = retried.json()
    assert fresh["state"] == "queued"
    assert fresh["retryOf"] == original_id
    assert fresh["id"] != original_id

    # History is preserved, not overwritten.
    original = (await client.get(f"/api/v1/tasks/{original_id}")).json()
    assert original["state"] == "failed"

    # A succeeded task cannot be retried.
    ok = await client.post(f"/api/v1/projects/{project_id}/tasks/import", files=_upload(GEOJSON))
    await task_worker.run_once(db_session)
    conflict = await client.post(f"/api/v1/tasks/{ok.json()['id']}/retry")
    assert conflict.status_code == 409


# -------------------------------------------------- listing and pagination


async def test_listing_filters_and_paginates_stably(
    client: AsyncClient, db_session: AsyncSession, project_id: str
) -> None:
    import uuid as uuid_module

    other_project = (await client.post("/api/v1/projects", json={"name": "Other"})).json()["id"]
    pid = uuid_module.UUID(project_id)
    for index in range(3):
        await task_service.create_task(
            db_session, project_id=pid, kind=f"kind_{index % 2}", params={"n": index}
        )
    await task_service.create_task(
        db_session, project_id=uuid_module.UUID(other_project), kind="kind_0", params={}
    )

    mine = (await client.get("/api/v1/tasks", params={"projectId": project_id})).json()
    assert mine["total"] == 3
    assert [item["projectName"] for item in mine["items"]] == ["Tasks"] * 3

    kind0 = (
        await client.get("/api/v1/tasks", params={"projectId": project_id, "type": "kind_0"})
    ).json()
    assert kind0["total"] == 2

    queued = (await client.get("/api/v1/tasks", params={"state": "queued"})).json()
    assert queued["total"] >= 4

    bad_state = await client.get("/api/v1/tasks", params={"state": "sideways"})
    assert bad_state.status_code == 422

    page_one = (
        await client.get("/api/v1/tasks", params={"projectId": project_id, "pageSize": 2})
    ).json()
    page_two = (
        await client.get(
            "/api/v1/tasks", params={"projectId": project_id, "pageSize": 2, "page": 2}
        )
    ).json()
    assert len(page_one["items"]) == 2
    assert len(page_two["items"]) == 1
    ids = [item["id"] for item in page_one["items"] + page_two["items"]]
    assert len(set(ids)) == 3  # stable ordering, no overlap between pages


# ------------------------------------------------ restart + provenance


async def test_startup_recovery_fails_interrupted_work_but_keeps_queued(
    client: AsyncClient, db_session: AsyncSession, project_id: str
) -> None:
    import uuid as uuid_module

    from sqlalchemy import update as sa_update

    from app.models.task import Task

    pid = uuid_module.UUID(project_id)
    interrupted = await task_service.create_task(db_session, project_id=pid, kind="x", params={})
    queued = await task_service.create_task(db_session, project_id=pid, kind="x", params={})
    interrupted_id, queued_id = str(interrupted.id), str(queued.id)
    await db_session.execute(
        sa_update(Task).where(Task.id == interrupted.id).values(state="running")
    )
    await db_session.flush()

    recovered = await task_worker.recover_interrupted(db_session)
    assert recovered == 1
    # The bulk update deliberately skips in-memory synchronization; drop
    # every cached instance (ids captured above — an expired attribute
    # cannot be read synchronously on an async session).
    db_session.expire_all()

    after = (await client.get(f"/api/v1/tasks/{interrupted_id}")).json()
    assert after["state"] == "failed"
    assert after["error"]["code"] == "interrupted"
    still_queued = (await client.get(f"/api/v1/tasks/{queued_id}")).json()
    assert still_queued["state"] == "queued"


async def test_synchronous_import_is_recorded_in_shared_task_history(
    client: AsyncClient, project_id: str
) -> None:
    imported = await client.post(
        f"/api/v1/projects/{project_id}/layers/import", files=_upload(GEOJSON)
    )
    assert imported.status_code == 201, imported.text
    layer = imported.json()

    tasks = (
        await client.get("/api/v1/tasks", params={"projectId": project_id, "type": "vector_import"})
    ).json()
    assert tasks["total"] == 1
    record = tasks["items"][0]
    assert record["state"] == "succeeded"
    assert record["provenance"]["sourceFilename"] == "cities.geojson"
    assert record["provenance"]["executedInRequest"] is True
    assert record["result"]["layerId"] == layer["id"]
    assert record["layerId"] == layer["id"]
    assert record["retryable"] is False  # nothing re-runnable was persisted
