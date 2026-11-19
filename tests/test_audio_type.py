import httpx
import pytest
from fastapi.testclient import TestClient

import server

ENDPOINTS = ["/transcriptions", "/transcribe"]
ACCEPTED = ["audio/webm;codecs=opus", "audio/webm; codecs=opus", "AUDIO/WEBM", "audio/ogg;codecs=opus"]
REJECTED = ["text/plain", "audio/x-qualquer"]


class StopAfterUpload(Exception):
    """Interrompe o fluxo logo após a validação, sem chamar provedores de verdade."""


@pytest.fixture(autouse=True)
def api_key(monkeypatch):
    monkeypatch.setattr(server, "API_KEY", "fictional-test-key")


@pytest.fixture
def client():
    # raise_server_exceptions=False: a exceção simulada vira resposta 500 em vez de estourar no teste.
    with TestClient(server.app, raise_server_exceptions=False) as test_client:
        yield test_client


@pytest.fixture
def upload_calls(monkeypatch):
    """Registra os POST ao provedor. /transcribe cria o próprio httpx.AsyncClient, então o patch é na classe."""
    calls = []

    async def fake_post(self, *args, **kwargs):
        calls.append(args[0] if args else kwargs.get("url"))
        raise StopAfterUpload()

    monkeypatch.setattr(httpx.AsyncClient, "post", fake_post)
    return calls


def _send(client, endpoint, content_type):
    return client.post(endpoint, files={"audio": ("fictitious.webm", b"fake-audio-bytes", content_type)})


@pytest.mark.parametrize("endpoint", ENDPOINTS)
@pytest.mark.parametrize("content_type", ACCEPTED)
def test_accepted_base_types_pass_validation(client, upload_calls, endpoint, content_type):
    result = _send(client, endpoint, content_type)
    assert result.status_code != 415
    assert len(upload_calls) == 1


@pytest.mark.parametrize("endpoint", ENDPOINTS)
@pytest.mark.parametrize("content_type", REJECTED)
def test_rejected_types_return_415_without_calling_provider(client, upload_calls, endpoint, content_type):
    result = _send(client, endpoint, content_type)
    assert result.status_code == 415
    assert upload_calls == []


@pytest.mark.parametrize("endpoint", ENDPOINTS)
def test_missing_content_type_uses_octet_stream_fallback(client, upload_calls, endpoint):
    # Comportamento atual mantido: cabeçalho vazio vira application/octet-stream, que está na lista.
    result = _send(client, endpoint, "")
    assert result.status_code != 415
    assert len(upload_calls) == 1


@pytest.mark.parametrize("endpoint", ENDPOINTS)
def test_error_message_does_not_echo_header_parameters(client, upload_calls, endpoint):
    result = _send(client, endpoint, "text/plain;evil=SECRETVALUE")
    assert result.status_code == 415
    assert "text/plain" in result.json()["detail"]
    assert "SECRETVALUE" not in result.text
    assert upload_calls == []
