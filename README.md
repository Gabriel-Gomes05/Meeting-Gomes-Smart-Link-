# VOXMED

Aplicacao web com frontend estatico e backend FastAPI para transcricao de reunioes.

## Subir no Render

1. Envie este projeto para um repositorio no GitHub.
2. No Render, clique em `New +` -> `Blueprint`.
3. Selecione o repositorio deste projeto.
4. O Render vai ler o arquivo `render.yaml` automaticamente.
5. Preencha as variaveis de ambiente:
   - `ASSEMBLYAI_API_KEY`
   - `GROQ_API_KEY`
6. Conclua o deploy.

## Se preferir criar manualmente no Render

- Environment: `Python`
- Build Command: `pip install -r requirements.txt`
- Start Command: `uvicorn server:app --host 0.0.0.0 --port $PORT`

## Observacoes

- O arquivo `.env` nao vai para producao; configure as chaves no painel do Render.
- A pasta `static/` ja e servida pelo FastAPI em producao.
- A rota de status fica em `/health`.
- Acesse o deploy pela URL `https://` fornecida pelo Render. O Screen Wake Lock usado durante a gravacao exige um contexto seguro (HTTPS; `localhost` tambem e aceito em desenvolvimento).
