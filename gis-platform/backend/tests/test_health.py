from fastapi.testclient import TestClient

from app.main import create_app


def test_health_reports_ok_and_environment() -> None:
    client = TestClient(create_app())
    response = client.get("/api/v1/health")
    assert response.status_code == 200
    body = response.json()
    assert body["status"] == "ok"
    assert body["environment"] == "development"


def test_unknown_route_uses_error_envelope() -> None:
    client = TestClient(create_app())
    response = client.get("/api/v1/nope")
    assert response.status_code == 404
    assert set(response.json()["error"]) == {"code", "message", "details"}
