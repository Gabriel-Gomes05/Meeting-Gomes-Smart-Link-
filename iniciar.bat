@echo off
title Oratta - Da fala para a ata
echo ================================================
echo   Oratta - Da fala para a ata
echo ================================================
echo.

REM Verifica se o arquivo .env existe
if not exist ".env" (
    echo [AVISO] Arquivo .env nao encontrado!
    echo Copie o arquivo .env.example para .env e adicione as chaves da AssemblyAI e do Groq.
    echo.
    pause
    exit /b 1
)

REM Instala dependencias se necessario
if not exist "venv" (
    echo Criando ambiente virtual...
    python -m venv venv
    echo.
)

echo Ativando ambiente virtual...
call venv\Scripts\activate.bat

echo Instalando dependencias...
pip install -r requirements.txt --quiet

echo.
echo Iniciando servidor em http://localhost:8000
echo Pressione CTRL+C para encerrar.
echo.
start "" "http://localhost:8000"
uvicorn server:app --host 0.0.0.0 --port 8000 --reload
