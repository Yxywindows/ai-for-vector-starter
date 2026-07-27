from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.core.errors import (
    AppError,
    ConflictError,
    NotFoundError,
    register_exception_handlers,
)


def _app() -> FastAPI:
    app = FastAPI()
    register_exception_handlers(app)

    @app.get("/missing")
    def missing() -> None:
        raise NotFoundError("Layer 7 not found", details={"layerId": 7})

    @app.get("/conflict")
    def conflict() -> None:
        raise ConflictError("Name already used")

    @app.get("/boom")
    def boom() -> None:
        raise RuntimeError("unexpected")

    return app


def test_app_error_becomes_envelope_with_status_and_code() -> None:
    client = TestClient(_app())
    response = client.get("/missing")
    assert response.status_code == 404
    assert response.json() == {
        "error": {
            "code": "not_found",
            "message": "Layer 7 not found",
            "details": {"layerId": 7},
        }
    }


def test_conflict_error_uses_its_own_status_and_code() -> None:
    client = TestClient(_app())
    response = client.get("/conflict")
    assert response.status_code == 409
    assert response.json()["error"]["code"] == "conflict"
    assert response.json()["error"]["details"] is None


def test_unexpected_exception_is_masked_as_internal_error() -> None:
    client = TestClient(_app(), raise_server_exceptions=False)
    response = client.get("/boom")
    assert response.status_code == 500
    assert response.json() == {
        "error": {"code": "internal_error", "message": "Internal server error", "details": None}
    }


def test_base_app_error_defaults() -> None:
    error = AppError("something")
    assert error.status_code == 500
    assert error.code == "internal_error"
    assert error.details is None
