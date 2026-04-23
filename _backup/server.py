import os
import asyncio
import logging
import httpx
from datetime import datetime
from pathlib import Path
from fastapi import FastAPI, UploadFile, File, HTTPException, Request
from fastapi.staticfiles import StaticFiles
from fastapi.middleware.cors import CORSMiddleware
from dotenv import load_dotenv

load_dotenv()

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger(__name__)

API_KEY  = os.getenv("ASSEMBLYAI_API_KEY", "")
BASE_URL = "https://api.assemblyai.com/v2"

app = FastAPI(title="Transcritor de Reuniões")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.post("/transcribe")
async def transcribe(
    audio: UploadFile = File(...),
    speakers: int = 0,          # 0 = detectar automaticamente
):
    if not API_KEY:
        raise HTTPException(400, "ASSEMBLYAI_API_KEY não configurada no arquivo .env")

    auth    = {"authorization": API_KEY}
    content = await audio.read()
    log.info("Áudio recebido: %s bytes | tipo: %s | falantes esperados: %s",
             len(content), audio.content_type, speakers or "auto")

    async with httpx.AsyncClient(timeout=300) as client:

        # 1. Upload
        upload = await client.post(f"{BASE_URL}/upload", headers=auth, content=content)
        if upload.status_code != 200:
            log.error("Upload falhou: %s", upload.text)
            raise HTTPException(500, f"Falha no upload: {upload.text}")

        audio_url = upload.json()["upload_url"]
        log.info("Upload OK → %s", audio_url)

        # 2. Criar transcrição
        payload: dict = {
            "audio_url":          audio_url,
            "speaker_labels":     True,
            "speech_models":      ["universal-2"],
            "language_detection": True,
        }
        if speakers > 0:
            payload["speakers_expected"] = speakers

        create = await client.post(
            f"{BASE_URL}/transcript",
            headers={**auth, "content-type": "application/json"},
            json=payload,
        )
        if create.status_code != 200:
            log.error("Criação falhou: %s", create.text)
            raise HTTPException(500, f"Falha ao criar transcrição: {create.text}")

        transcript_id = create.json()["id"]
        log.info("Transcrição criada: %s", transcript_id)

        # 3. Polling
        poll_url = f"{BASE_URL}/transcript/{transcript_id}"
        for attempt in range(120):
            await asyncio.sleep(3)
            poll = await client.get(poll_url, headers=auth)
            data = poll.json()
            log.info("Poll #%d → status: %s", attempt + 1, data["status"])

            if data["status"] == "completed":
                utterances = []
                for u in data.get("utterances") or []:
                    utterances.append({
                        "speaker":  u["speaker"],
                        "text":     u["text"],
                        "start_ms": u["start"],
                        "end_ms":   u["end"],
                    })

                speakers_found = len({u["speaker"] for u in utterances})
                log.info(
                    "Concluído: %d utterances | %d falante(s) | idioma: %s",
                    len(utterances), speakers_found, data.get("language_code"),
                )

                # 4. Resumo via LeMUR
                summary = ""
                try:
                    lemur = await client.post(
                        "https://api.assemblyai.com/lemur/v3/task",
                        headers={**auth, "content-type": "application/json"},
                        json={
                            "transcript_ids": [transcript_id],
                            "prompt": (
                                "Gere um resumo em bullet points dos principais assuntos, "
                                "decisões e pontos de ação discutidos nesta reunião. "
                                "Responda no mesmo idioma da gravação. "
                                "Use o formato: cada ponto em uma linha começando com '- '."
                            ),
                            "final_model": "anthropic/claude-3-5-sonnet",
                        },
                        timeout=60,
                    )
                    if lemur.status_code == 200:
                        summary = lemur.json().get("response", "")
                        log.info("Resumo gerado: %d chars", len(summary))
                    else:
                        log.warning("LeMUR falhou (%s): %s", lemur.status_code, lemur.text)
                except Exception as exc:
                    log.warning("Erro ao gerar resumo: %s", exc)

                return {
                    "full_text":      data.get("text", ""),
                    "utterances":     utterances,
                    "language_code":  data.get("language_code"),
                    "speakers_found": speakers_found,
                    "summary":        summary,
                }

            if data["status"] == "error":
                log.error("AssemblyAI erro: %s", data.get("error"))
                raise HTTPException(500, f"Erro na transcrição: {data.get('error')}")

        raise HTTPException(504, "Tempo limite de transcrição atingido.")


@app.post("/save")
async def save_transcription(request: Request):
    body = await request.json()
    text = body.get("text", "")

    save_dir = Path("transcricoes")
    save_dir.mkdir(exist_ok=True)

    timestamp = datetime.now().strftime("%Y-%m-%d_%H-%M-%S")
    filename = f"transcricao_{timestamp}.txt"
    (save_dir / filename).write_text(text, encoding="utf-8")
    log.info("Transcrição salva: %s", filename)

    return {"filename": filename}


@app.get("/health")
def health():
    return {"status": "ok", "api_key_configured": bool(API_KEY)}


app.mount("/", StaticFiles(directory="static", html=True), name="static")
