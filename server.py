import asyncio
import logging
import os
from time import perf_counter
from datetime import datetime
from pathlib import Path

import httpx
from dotenv import load_dotenv
from fastapi import FastAPI, File, HTTPException, Request, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles

load_dotenv()

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger(__name__)

API_KEY = os.getenv("ASSEMBLYAI_API_KEY", "")
GEMINI_KEY = os.getenv("GEMINI_API_KEY", "")
GROQ_KEY = os.getenv("GROQ_API_KEY", "")
BASE_URL = "https://api.assemblyai.com/v2"
GROQ_URL = "https://api.groq.com/openai/v1/chat/completions"

DEFAULT_SUMMARY_PROMPT = (
    "Gere um resumo em bullet points dos principais assuntos, "
    "decisões e pontos de ação discutidos nesta reunião. "
    "Responda no mesmo idioma da gravação. "
    "Use o formato: cada ponto em uma linha começando com '- '."
)

app = FastAPI(title="Transcritor de Reunioes")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


def _extract_summary_error(resp: httpx.Response) -> str:
    try:
        data = resp.json()
    except ValueError:
        data = {}

    message = (
        data.get("error", {}).get("message")
        or data.get("message")
        or resp.text.strip()
        or f"HTTP {resp.status_code}"
    )
    return " ".join(str(message).split())[:300]


async def generate_summary(client: httpx.AsyncClient, text: str, prompt: str) -> str:
    if not GROQ_KEY or not text.strip():
        return ""

    full_prompt = f"{prompt}\n\nTranscricao:\n{text}"
    resp = await client.post(
        GROQ_URL,
        headers={
            "Authorization": f"Bearer {GROQ_KEY}",
            "Content-Type": "application/json",
        },
        json={
            "model": "llama-3.1-8b-instant",
            "messages": [
                {
                    "role": "system",
                    "content": "Voce gera resumos curtos, claros e uteis.",
                },
                {
                    "role": "user",
                    "content": full_prompt,
                },
            ],
            "temperature": 0.2,
        },
        timeout=60,
    )

    if resp.status_code != 200:
        detail = _extract_summary_error(resp)
        log.warning("Groq falhou (%s): %s", resp.status_code, detail)
        raise RuntimeError(detail)

    try:
        return resp.json()["choices"][0]["message"]["content"]
    except (KeyError, IndexError, TypeError):
        detail = _extract_summary_error(resp)
        log.warning("Groq respondeu em formato inesperado: %s", detail)
        raise RuntimeError(f"Resposta inesperada do Groq: {detail}")


def _elapsed_seconds(started_at: float) -> float:
    return round(perf_counter() - started_at, 2)


@app.post("/transcribe")
async def transcribe(
    audio: UploadFile = File(...),
    speakers: int = 0,
    prompt: str = "",
    include_summary: bool = False,
):
    if not API_KEY:
        raise HTTPException(400, "ASSEMBLYAI_API_KEY nao configurada no arquivo .env")

    request_started_at = perf_counter()
    auth = {"authorization": API_KEY}
    content = await audio.read()
    log.info(
        "Audio recebido: %s bytes | tipo: %s | falantes esperados: %s | leitura=%.2fs",
        len(content),
        audio.content_type,
        speakers or "auto",
        _elapsed_seconds(request_started_at),
    )

    async with httpx.AsyncClient(timeout=300) as client:
        upload_started_at = perf_counter()
        upload = await client.post(f"{BASE_URL}/upload", headers=auth, content=content)
        if upload.status_code != 200:
            log.error("Upload falhou: %s", upload.text)
            raise HTTPException(500, f"Falha no upload: {upload.text}")

        audio_url = upload.json()["upload_url"]
        log.info(
            "Upload OK -> %s | upload=%.2fs | total=%.2fs",
            audio_url,
            _elapsed_seconds(upload_started_at),
            _elapsed_seconds(request_started_at),
        )

        payload: dict = {
            "audio_url": audio_url,
            "speaker_labels": True,
            "speech_models": ["universal-3-pro"],
            "language_detection": True,
        }
        if speakers > 0:
            payload["speakers_expected"] = speakers

        create_started_at = perf_counter()
        create = await client.post(
            f"{BASE_URL}/transcript",
            headers={**auth, "content-type": "application/json"},
            json=payload,
        )
        if create.status_code != 200:
            log.error("Criacao falhou: %s", create.text)
            raise HTTPException(500, f"Falha ao criar transcricao: {create.text}")

        transcript_id = create.json()["id"]
        log.info(
            "Transcricao criada: %s | create=%.2fs | total=%.2fs",
            transcript_id,
            _elapsed_seconds(create_started_at),
            _elapsed_seconds(request_started_at),
        )

        # Polling com backoff: 1s nas primeiras 5 tentativas, 2s nas 5 seguintes, 3s após isso
        poll_url = f"{BASE_URL}/transcript/{transcript_id}"
        poll_started_at = perf_counter()
        for attempt in range(120):
            if attempt < 5:
                await asyncio.sleep(1)
            elif attempt < 10:
                await asyncio.sleep(2)
            else:
                await asyncio.sleep(3)
            poll = await client.get(poll_url, headers=auth)
            data = poll.json()
            log.info(
                "Poll #%d -> status: %s | polling=%.2fs | total=%.2fs",
                attempt + 1,
                data["status"],
                _elapsed_seconds(poll_started_at),
                _elapsed_seconds(request_started_at),
            )

            if data["status"] == "completed":
                utterances = []
                for utterance in data.get("utterances") or []:
                    utterances.append(
                        {
                            "speaker": utterance["speaker"],
                            "text": utterance["text"],
                            "start_ms": utterance["start"],
                            "end_ms": utterance["end"],
                        }
                    )

                speakers_found = len({item["speaker"] for item in utterances})
                full_text = data.get("text", "")
                log.info(
                    "Concluido: %d utterances | %d falante(s) | idioma: %s | polling=%.2fs | total=%.2fs",
                    len(utterances),
                    speakers_found,
                    data.get("language_code"),
                    _elapsed_seconds(poll_started_at),
                    _elapsed_seconds(request_started_at),
                )

                summary = ""
                if include_summary:
                    summary_prompt = prompt.strip() or DEFAULT_SUMMARY_PROMPT
                    summary_started_at = perf_counter()
                    try:
                        summary = await generate_summary(client, full_text, summary_prompt)
                        log.info(
                            "Resumo inline concluido | chars=%d | resumo=%.2fs | total=%.2fs",
                            len(summary),
                            _elapsed_seconds(summary_started_at),
                            _elapsed_seconds(request_started_at),
                        )
                    except Exception as exc:
                        log.warning("Erro ao gerar resumo com Groq: %s", exc)

                return {
                    "full_text": full_text,
                    "utterances": utterances,
                    "language_code": data.get("language_code"),
                    "speakers_found": speakers_found,
                    "summary": summary,
                    "transcript_id": transcript_id,
                    "summary_pending": bool(GROQ_KEY and full_text and not include_summary),
                }

            if data["status"] == "error":
                log.error("AssemblyAI erro: %s", data.get("error"))
                raise HTTPException(500, f"Erro na transcricao: {data.get('error')}")

        raise HTTPException(504, "Tempo limite de transcricao atingido.")


@app.post("/summarize")
async def summarize(request: Request):
    request_started_at = perf_counter()
    body = await request.json()
    text = body.get("text", "")
    prompt = (body.get("prompt") or "").strip() or DEFAULT_SUMMARY_PROMPT

    if not GROQ_KEY:
        raise HTTPException(
            503,
            "GROQ_API_KEY nao configurada no .env.",
        )

    if not text:
        raise HTTPException(400, "Forneca text no corpo da requisicao")

    try:
        async with httpx.AsyncClient(timeout=60) as client:
            summary = await generate_summary(client, text, prompt)
    except RuntimeError as exc:
        raise HTTPException(503, f"Falha ao gerar resumo com Groq: {exc}") from exc

    if not summary:
        raise HTTPException(503, "O Groq nao retornou conteudo para este resumo.")

    log.info(
        "Resumo concluido | chars=%d | total=%.2fs",
        len(summary),
        _elapsed_seconds(request_started_at),
    )
    return {"summary": summary}


@app.post("/save")
async def save_transcription(request: Request):
    body = await request.json()
    text = body.get("text", "")

    save_dir = Path("transcricoes")
    save_dir.mkdir(exist_ok=True)

    timestamp = datetime.now().strftime("%Y-%m-%d_%H-%M-%S")
    filename = f"transcricao_{timestamp}.txt"
    (save_dir / filename).write_text(text, encoding="utf-8")
    log.info("Transcricao salva: %s", filename)

    return {"filename": filename}


@app.get("/health")
def health():
    return {
        "status": "ok",
        "api_key_configured": bool(API_KEY),
        "gemini_configured": bool(GROQ_KEY),
    }


app.mount("/", StaticFiles(directory="static", html=True), name="static")
