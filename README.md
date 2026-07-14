# Oratta

> Da fala para a ata.

Aplicação web para gravar reuniões, identificar falantes, transcrever o áudio e gerar resumos. O processamento ocorre em segundo plano: ao encerrar uma gravação, ela entra no histórico e a interface fica livre para iniciar outra.

## Principais recursos

- gravação pelo microfone ou áudio compartilhado pela tela;
- transcrição assíncrona com identificação de falantes via AssemblyAI;
- múltiplas transcrições em processamento ao mesmo tempo;
- retomada automática de trabalhos pendentes após recarregar a página;
- resumos personalizados gerados pelo Groq;
- histórico local, renomeação de falantes, cópia, download e compartilhamento;
- Screen Wake Lock para manter a tela ativa durante a gravação em navegadores compatíveis;
- interface responsiva e pronta para instalação no Render.

## Arquitetura

```text
static/             Frontend HTML, CSS e JavaScript sem etapa de build
server.py           API FastAPI e integração com AssemblyAI/Groq
docs/               Manual de uso em HTML e PDF
render.yaml         Infraestrutura declarativa para o Render
requirements.txt    Dependências Python fixadas
```

Fluxo principal:

```text
Navegador -> POST /transcriptions -> AssemblyAI
          <- transcript_id
Navegador -> GET /transcriptions/{id} (polling)
          <- processing | completed | error
Navegador -> POST /summarize -> Groq (opcional)
```

O histórico fica no `localStorage` do navegador. A pasta `transcricoes/`, criada pelo endpoint `/save`, é armazenamento local e efêmero em hospedagens sem disco persistente.

## Pré-requisitos

- Python 3.11 ou superior;
- chave da [AssemblyAI](https://www.assemblyai.com/);
- chave do [Groq](https://console.groq.com/) para habilitar resumos.

## Execução local

```powershell
python -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install -r requirements.txt
Copy-Item .env.example .env
```

Preencha as chaves no `.env` e execute:

```powershell
python -m uvicorn server:app --reload --host 127.0.0.1 --port 8000
```

Acesse `http://127.0.0.1:8000`. O endpoint de diagnóstico fica em `http://127.0.0.1:8000/health` e a documentação interativa da API em `/docs`.

## Variáveis de ambiente

| Variável | Obrigatória | Descrição |
|---|---:|---|
| `ASSEMBLYAI_API_KEY` | Sim | Upload, diarização e transcrição de áudio. |
| `GROQ_API_KEY` | Não | Geração de resumos. Sem ela, a transcrição continua funcionando. |
| `MAX_AUDIO_MB` | Não | Tamanho máximo por upload. O padrão é `100`. |
| `PORT` | Produção | Porta injetada automaticamente pelo Render. |

Nunca versione o arquivo `.env`. O repositório contém somente `.env.example`, sem credenciais reais.

## Endpoints

| Método | Rota | Finalidade |
|---|---|---|
| `GET` | `/health` | Estado da aplicação e disponibilidade das integrações. |
| `POST` | `/transcriptions` | Envia um áudio e devolve um identificador de trabalho. |
| `GET` | `/transcriptions/{id}` | Consulta o estado e o resultado de um trabalho. |
| `POST` | `/summarize` | Gera um resumo para um texto já transcrito. |
| `POST` | `/save` | Salva uma cópia `.txt` no servidor local. |
| `POST` | `/transcribe` | Fluxo síncrono legado, preservado para compatibilidade. |

Uploads aceitam WebM, MP4, MPEG, OGG e WAV. O backend valida tipo, conteúdo vazio e limite de tamanho antes de chamar serviços externos.

## Verificações de qualidade

Antes de criar um commit:

```powershell
python -m compileall server.py
python -m pip check
node --check static/app.js
```

Para uma verificação rápida de execução, inicie a aplicação e consulte:

```powershell
Invoke-RestMethod http://127.0.0.1:8000/health
```

Uma transcrição ponta a ponta consome as APIs externas e exige credenciais válidas.

## Deploy no Render

1. Faça push do projeto para o GitHub.
2. No Render, selecione **New + > Blueprint**.
3. Conecte o repositório e aplique o `render.yaml`.
4. Cadastre `ASSEMBLYAI_API_KEY` e, opcionalmente, `GROQ_API_KEY` no painel.
5. Aguarde o health check em `/health` ficar disponível.

O Render executa:

```text
Build: pip install -r requirements.txt
Start: uvicorn server:app --host 0.0.0.0 --port $PORT
```

Microfone, compartilhamento nativo e Wake Lock dependem de HTTPS fora do `localhost`.

## Boas práticas adotadas

- segredos apenas por variáveis de ambiente;
- validação tipada dos corpos JSON com Pydantic;
- limite e validação de formato nos uploads;
- IDs externos validados antes de compor URLs;
- erros de provedores normalizados antes de chegar ao cliente;
- processamento assíncrono para não bloquear novas gravações;
- arquivos gerados, ambientes virtuais e caches fora do Git.

## Manual

O guia completo para usuários está em [docs/Manual_Oratta.pdf](docs/Manual_Oratta.pdf). A versão HTML editável fica no mesmo diretório.
