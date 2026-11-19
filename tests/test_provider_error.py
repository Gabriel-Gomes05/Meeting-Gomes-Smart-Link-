import httpx
import pytest
from fastapi.testclient import TestClient

import server

FICTITIOUS_UPLOAD_URL = "https://upload.example.invalid/fake-audio"


def _resp(status, body=None, text=None):
    if text is not None:
        return httpx.Response(status, content=text.encode())
    return httpx.Response(status, json=body)


def _queue_post(monkeypatch, responses):
    """Respostas simuladas para cada POST ao provedor, na ordem; sem rede."""
    queue = list(responses)

    async def fake_post(self, *args, **kwargs):
        return queue.pop(0)

    monkeypatch.setattr(httpx.AsyncClient, "post", fake_post)


def _queue_get(monkeypatch, response):
    async def fake_get(self, *args, **kwargs):
        return response

    monkeypatch.setattr(httpx.AsyncClient, "get", fake_get)


@pytest.fixture(autouse=True)
def api_key(monkeypatch):
    monkeypatch.setattr(server, "API_KEY", "fictional-test-key")


@pytest.fixture
def client():
    with TestClient(server.app, raise_server_exceptions=False) as test_client:
        yield test_client


def _upload(client):
    return client.post("/transcriptions", files={"audio": ("fictitious.webm", b"fake-audio", "audio/webm")})


# --- _extract_summary_error: formatos de erro do provedor ---

@pytest.mark.parametrize(
    "resp, expected",
    [
        (_resp(401, {"error": "Invalid key"}), "Invalid key"),
        (_resp(402, {"error": {"message": "Quota exceeded"}}), "Quota exceeded"),
        (_resp(400, {"message": "Bad request"}), "Bad request"),
        (_resp(500, text=""), "HTTP 500"),
        (_resp(503, text="<html>Bad gateway</html>"), "<html>Bad gateway</html>"),
    ],
)
def test_extract_summary_error_formats(resp, expected):
    assert server._extract_summary_error(resp) == expected


def test_extract_summary_error_list_body_does_not_raise():
    message = server._extract_summary_error(_resp(401, [1, 2]))
    assert message  # usa o texto da resposta, sem AttributeError


def test_extract_summary_error_is_clipped_to_300_chars():
    long_text = "x" * 1000
    assert len(server._extract_summary_error(_resp(500, {"error": long_text}))) == 300


# --- endpoints: o app responde 502 com mensagem, nunca 500 ---

@pytest.mark.parametrize(
    "upload_resp",
    [
        _resp(401, {"error": "Invalid key"}),
        _resp(401, {"error": {"message": "Quota exceeded"}}),
        _resp(401, {"message": "Bad request"}),
        _resp(401, [1, 2]),
        _resp(401, text=""),
        _resp(503, text="<html>Bad gateway</html>"),
    ],
)
def test_upload_provider_error_returns_502_not_500(client, monkeypatch, upload_resp):
    _queue_post(monkeypatch, [upload_resp])
    result = _upload(client)
    assert result.status_code == 502
    assert "Falha no upload" in result.json()["detail"]


def test_create_success_with_non_object_json_returns_502(client, monkeypatch):
    _queue_post(monkeypatch, [_resp(200, {"upload_url": FICTITIOUS_UPLOAD_URL}), _resp(200, [1])])
    result = _upload(client)
    assert result.status_code == 502
    assert "Resposta inesperada" in result.json()["detail"]


def test_status_query_with_non_object_json_returns_502(client, monkeypatch):
    _queue_get(monkeypatch, _resp(200, [1, 2]))
    result = client.get("/transcriptions/job_fake_1")
    assert result.status_code == 502


def test_status_query_error_text_is_returned_as_message(client, monkeypatch):
    _queue_get(monkeypatch, _resp(200, {"status": "error", "error": "Audio too short"}))
    result = client.get("/transcriptions/job_fake_1")
    assert result.status_code == 200
    assert result.json() == {"status": "error", "error": "Audio too short"}


def test_legacy_transcribe_error_status_returns_502_not_500(client, monkeypatch):
    _queue_post(
        monkeypatch,
        [
            _resp(200, {"upload_url": FICTITIOUS_UPLOAD_URL}),
            _resp(200, {"id": "job_fake_1"}),
        ],
    )
    _queue_get(monkeypatch, _resp(200, {"status": "error", "error": {"message": "Unsupported audio"}}))
    result = client.post("/transcribe", files={"audio": ("fictitious.webm", b"fake-audio", "audio/webm")})
    assert result.status_code == 502
    assert "Unsupported audio" in result.json()["detail"]


def test_provider_body_is_not_logged(client, monkeypatch, caplog):
    caplog.set_level("INFO", logger="server")
    secret_like = "PROVIDER-BODY-FICTITIOUS-MARKER"
    _queue_post(monkeypatch, [_resp(401, text=secret_like * 3)])
    _upload(client)
    assert secret_like not in caplog.text
