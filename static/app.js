// ============================================================
//  MeetingScript — app.js
// ============================================================

const SPEAKER_COLORS = [
  '#6c63ff','#f43f5e','#22c55e','#f59e0b',
  '#38bdf8','#f472b6','#a3e635','#fb923c',
];

const DEFAULT_PROMPTS = [
  {
    id: 'resumo-executivo',
    name: 'Resumo Executivo',
    description: 'Bullet points dos principais tópicos, decisões e pontos de ação',
    text: 'Gere um resumo em bullet points dos principais assuntos, decisões e pontos de ação discutidos nesta reunião. Responda no mesmo idioma da gravação. Use o formato: cada ponto em uma linha começando com "- ".',
  },
  {
    id: 'ata-formal',
    name: 'Ata de Reunião',
    description: 'Formato formal com participantes, decisões e próximos passos',
    text: 'Gere uma ata de reunião formal com as seguintes seções:\n1. Participantes\n2. Assuntos Discutidos\n3. Decisões Tomadas\n4. Próximos Passos\n\nResponda no mesmo idioma da gravação. Seja objetivo e formal.',
  },
  {
    id: 'action-items',
    name: 'Tarefas e Ações',
    description: 'Foco em tarefas, responsáveis e prazos mencionados',
    text: 'Liste todas as tarefas, ações e próximos passos mencionados na reunião. Para cada item informe: a tarefa, quem é responsável (se mencionado) e prazo (se mencionado). Use bullet points iniciados com "- ". Responda no mesmo idioma da gravação.',
  },
  {
    id: 'insights',
    name: 'Insights e Análise',
    description: 'Temas principais, decisões e pontos relevantes em profundidade',
    text: 'Analise a reunião e forneça:\n1) Os 3-5 principais temas discutidos\n2) Decisões importantes tomadas\n3) Riscos ou preocupações levantadas\n4) Recomendações para próximas reuniões\n\nResponda no mesmo idioma da gravação.',
  },
];

// ── Estado ──────────────────────────────────────────────────
let mediaRecorder   = null;
let audioChunks     = [];
let timerInterval   = null;
let elapsedSecs     = 0;
let activeStreams    = [];
let animFrameId     = null;
let analyserNode    = null;
let audioCtxGlobal  = null;
let speakerNames    = new Map();
let lastTranscriptId = '';
let lastFullText     = '';
let geminiConfigured = false;
let prompts          = [];
let editingPromptId  = null;

// ── Elementos ────────────────────────────────────────────────
const btnRecord          = document.getElementById('btnRecord');
const btnStop            = document.getElementById('btnStop');
const recTimerWrap       = document.getElementById('recTimerWrap');
const recTimer           = document.getElementById('recTimer');
const processingCard     = document.getElementById('processingCard');
const processingTitle    = document.getElementById('processingTitle');
const resultCard         = document.getElementById('resultCard');
const resultMeta         = document.getElementById('resultMeta');
const speakerLegend      = document.getElementById('speakerLegend');
const speakerSection     = document.getElementById('speakerSection');
const utteranceList      = document.getElementById('utteranceList');
const apiStatus          = document.getElementById('apiStatus');
const apiStatusText      = document.getElementById('apiStatusText');
const tabBanner          = document.getElementById('tabBanner');
const waveCanvas         = document.getElementById('waveCanvas');
const waveformIdle       = document.getElementById('waveformIdle');
const btnDownload        = document.getElementById('btnDownload');
const btnCopy            = document.getElementById('btnCopy');
const btnClear           = document.getElementById('btnClear');
const btnSave            = document.getElementById('btnSave');
const summaryBlock       = document.getElementById('summaryBlock');
const summaryList        = document.getElementById('summaryList');
const summaryLoading     = document.getElementById('summaryLoading');
const summaryEmpty       = document.getElementById('summaryEmpty');
const promptSelect       = document.getElementById('promptSelect');
const summaryPromptSelect = document.getElementById('summaryPromptSelect');
const btnRegenerateSum   = document.getElementById('btnRegenerateSum');
const btnGoToLibrary     = document.getElementById('btnGoToLibrary');
const navTranscricao     = document.getElementById('navTranscricao');
const navBiblioteca      = document.getElementById('navBiblioteca');
const viewTranscricao    = document.getElementById('viewTranscricao');
const viewBiblioteca     = document.getElementById('viewBiblioteca');
const btnNewPrompt       = document.getElementById('btnNewPrompt');
const promptList         = document.getElementById('promptList');
const promptFormCard     = document.getElementById('promptFormCard');
const geminiBanner       = document.getElementById('geminiBanner');

// ── Init ─────────────────────────────────────────────────────
prompts = loadPrompts();
populatePromptSelects();
checkApiHealth();
setupSourceListeners();
setupNavListeners();
setupLibraryListeners();
resizeCanvas();
window.addEventListener('resize', resizeCanvas);

// ============================================================
//  Navegação entre views
// ============================================================
function setupNavListeners() {
  navTranscricao.addEventListener('click', () => showView('transcricao'));
  navBiblioteca.addEventListener('click',  () => showView('biblioteca'));
  btnGoToLibrary.addEventListener('click', () => showView('biblioteca'));
}

function showView(view) {
  viewTranscricao.hidden = view !== 'transcricao';
  viewBiblioteca.hidden  = view !== 'biblioteca';
  navTranscricao.classList.toggle('active', view === 'transcricao');
  navBiblioteca.classList.toggle('active', view === 'biblioteca');
  if (view === 'biblioteca') renderPromptList();
}

// ============================================================
//  API Health
// ============================================================
async function checkApiHealth() {
  try {
    const res  = await fetch('/health');
    const data = await res.json();
    geminiConfigured = data.gemini_configured || false;

    if (data.api_key_configured) {
      apiStatus.className       = 'api-badge ok';
      apiStatusText.textContent = 'API Conectada';
    } else {
      apiStatus.className       = 'api-badge err';
      apiStatusText.textContent = 'API Key ausente';
    }

    if (geminiBanner) geminiBanner.hidden = geminiConfigured;
  } catch {
    apiStatus.className       = 'api-badge err';
    apiStatusText.textContent = 'Servidor offline';
  }
}

// ============================================================
//  Fonte de áudio
// ============================================================
function setupSourceListeners() {
  document.querySelectorAll('input[name="source"]').forEach(r => {
    r.addEventListener('change', () => {
      tabBanner.hidden = (getSource() === 'mic');
    });
  });
}

function getSource()   { return document.querySelector('input[name="source"]:checked').value; }
function getSpeakers() { return document.querySelector('input[name="speakers"]:checked')?.value || '0'; }

// ============================================================
//  Biblioteca de Prompts — dados
// ============================================================
function loadPrompts() {
  const saved = localStorage.getItem('ms_prompts');
  if (saved) {
    try { return JSON.parse(saved); } catch {}
  }
  const ps = DEFAULT_PROMPTS.map(p => ({ ...p }));
  savePromptsToStorage(ps);
  return ps;
}

function savePromptsToStorage(ps) {
  localStorage.setItem('ms_prompts', JSON.stringify(ps));
}

function getSelectedPromptId() {
  return localStorage.getItem('ms_selected_prompt') || DEFAULT_PROMPTS[0].id;
}

function setSelectedPromptId(id) {
  localStorage.setItem('ms_selected_prompt', id);
}

function getSelectedPrompt() {
  const id = getSelectedPromptId();
  return prompts.find(p => p.id === id) || prompts[0];
}

function populatePromptSelects() {
  const selectedId = getSelectedPromptId();
  [promptSelect, summaryPromptSelect].forEach(sel => {
    if (!sel) return;
    sel.innerHTML = prompts.map(p =>
      `<option value="${escAttr(p.id)}"${p.id === selectedId ? ' selected' : ''}>${escHtml(p.name)}</option>`
    ).join('');
  });
}

promptSelect?.addEventListener('change', () => {
  setSelectedPromptId(promptSelect.value);
  if (summaryPromptSelect) summaryPromptSelect.value = promptSelect.value;
});

summaryPromptSelect?.addEventListener('change', () => {
  setSelectedPromptId(summaryPromptSelect.value);
  if (promptSelect) promptSelect.value = summaryPromptSelect.value;
});

// ============================================================
//  Biblioteca de Prompts — UI
// ============================================================
function setupLibraryListeners() {
  btnNewPrompt?.addEventListener('click', () => openForm(null));

  document.getElementById('btnCloseForm')?.addEventListener('click', () => {
    promptFormCard.hidden = true;
    editingPromptId = null;
  });

  document.getElementById('btnCancelPrompt')?.addEventListener('click', () => {
    promptFormCard.hidden = true;
    editingPromptId = null;
  });

  document.getElementById('btnSavePrompt')?.addEventListener('click', savePromptForm);

  // Event delegation para ações nos cards
  promptList?.addEventListener('click', e => {
    const btn = e.target.closest('[data-action]');
    if (!btn) return;
    const action = btn.dataset.action;
    const id     = btn.dataset.id;
    if (action === 'use')    usePrompt(id);
    if (action === 'edit')   openForm(id);
    if (action === 'delete') deletePrompt(id);
  });
}

function openForm(id) {
  editingPromptId = id;

  if (id) {
    const p = prompts.find(p => p.id === id);
    if (!p) return;
    document.getElementById('promptFormTitle').textContent = 'Editar Prompt';
    document.getElementById('pfName').value = p.name;
    document.getElementById('pfDesc').value = p.description || '';
    document.getElementById('pfText').value = p.text;
  } else {
    document.getElementById('promptFormTitle').textContent = 'Novo Prompt';
    document.getElementById('pfName').value = '';
    document.getElementById('pfDesc').value = '';
    document.getElementById('pfText').value = '';
  }

  promptFormCard.hidden = false;
  promptFormCard.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function savePromptForm() {
  const name = document.getElementById('pfName').value.trim();
  const desc = document.getElementById('pfDesc').value.trim();
  const text = document.getElementById('pfText').value.trim();

  if (!name) { document.getElementById('pfName').focus(); return; }
  if (!text) { document.getElementById('pfText').focus(); return; }

  if (editingPromptId) {
    const idx = prompts.findIndex(p => p.id === editingPromptId);
    if (idx >= 0) prompts[idx] = { ...prompts[idx], name, description: desc, text };
  } else {
    prompts.push({ id: 'p-' + Date.now(), name, description: desc, text });
  }

  savePromptsToStorage(prompts);
  promptFormCard.hidden = true;
  editingPromptId = null;
  populatePromptSelects();
  renderPromptList();
}

function usePrompt(id) {
  setSelectedPromptId(id);
  populatePromptSelects();
  renderPromptList();
}

function deletePrompt(id) {
  if (DEFAULT_PROMPTS.some(d => d.id === id)) {
    showError('Os prompts padrão não podem ser excluídos.');
    return;
  }
  if (!confirm('Excluir este prompt?')) return;
  prompts = prompts.filter(p => p.id !== id);
  savePromptsToStorage(prompts);
  if (getSelectedPromptId() === id) setSelectedPromptId(prompts[0]?.id || '');
  populatePromptSelects();
  renderPromptList();
}

function renderPromptList() {
  if (!promptList) return;
  const selectedId = getSelectedPromptId();
  const isDefault  = id => DEFAULT_PROMPTS.some(d => d.id === id);

  if (document.getElementById('libCount')) {
    const n = prompts.length;
    document.getElementById('libCount').textContent = `${n} prompt${n !== 1 ? 's' : ''}`;
  }

  promptList.innerHTML = prompts.map(p => {
    const active  = p.id === selectedId;
    const preview = p.text.length > 130 ? p.text.slice(0, 130) + '…' : p.text;

    return `
      <div class="prompt-card${active ? ' prompt-card--active' : ''}">
        <div class="prompt-card-header">
          <div class="prompt-card-name">
            ${escHtml(p.name)}
            ${active ? '<span class="prompt-badge-active">Ativo</span>' : ''}
          </div>
          <div class="prompt-card-actions">
            <button class="pcard-btn" data-action="edit" data-id="${escAttr(p.id)}" title="Editar">
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/>
                <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>
              </svg>
              Editar
            </button>
            ${!isDefault(p.id) ? `
            <button class="pcard-btn pcard-btn--danger" data-action="delete" data-id="${escAttr(p.id)}" title="Excluir">
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
                <polyline points="3 6 5 6 21 6"/>
                <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/>
              </svg>
              Excluir
            </button>` : ''}
          </div>
        </div>
        ${p.description ? `<p class="prompt-card-desc">${escHtml(p.description)}</p>` : ''}
        <p class="prompt-card-preview">${escHtml(preview)}</p>
        <div class="prompt-card-footer">
          ${active
            ? '<span class="prompt-active-label">Prompt selecionado — será usado na próxima transcrição</span>'
            : `<button class="btn-use-prompt" data-action="use" data-id="${escAttr(p.id)}">Usar como padrão</button>`
          }
        </div>
      </div>
    `;
  }).join('');
}

// ============================================================
//  Captura de áudio
// ============================================================
async function buildAudioStream(source) {
  const ctx         = new AudioContext();
  const destination = ctx.createMediaStreamDestination();

  analyserNode         = ctx.createAnalyser();
  analyserNode.fftSize = 256;
  analyserNode.connect(destination);
  audioCtxGlobal = ctx;
  activeStreams   = [];

  if (source === 'mic' || source === 'both') {
    const mic = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    activeStreams.push(mic);
    ctx.createMediaStreamSource(mic).connect(analyserNode);
  }

  if (source === 'system' || source === 'both') {
    const display = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
    display.getVideoTracks().forEach(t => t.stop());

    if (display.getAudioTracks().length === 0) {
      throw new Error(
        'Nenhum áudio encontrado na aba selecionada.\n' +
        'Marque "Compartilhar áudio da aba" no seletor do navegador.'
      );
    }

    activeStreams.push(display);
    ctx.createMediaStreamSource(display).connect(analyserNode);
    display.getAudioTracks()[0].addEventListener('ended', () => {
      if (mediaRecorder?.state === 'recording') stopRecording();
    });
  }

  return destination.stream;
}

// ============================================================
//  Iniciar gravação
// ============================================================
btnRecord.addEventListener('click', async () => {
  try {
    const stream   = await buildAudioStream(getSource());
    const mimeType = getSupportedMimeType();
    audioChunks    = [];
    mediaRecorder  = new MediaRecorder(stream, mimeType ? { mimeType } : {});

    mediaRecorder.ondataavailable = e => { if (e.data.size > 0) audioChunks.push(e.data); };
    mediaRecorder.onstop          = () => sendAudio(mimeType || 'audio/webm');
    mediaRecorder.start(500);

    btnRecord.disabled         = true;
    btnRecord.classList.add('recording');
    btnStop.disabled           = false;
    recTimerWrap.hidden        = false;
    resultCard.hidden          = true;
    processingCard.hidden      = true;
    waveformIdle.style.display = 'none';

    startTimer();
    drawWaveform();
  } catch (err) {
    console.error(err);
    showError(friendlyError(err));
  }
});

// ============================================================
//  Parar gravação
// ============================================================
btnStop.addEventListener('click', stopRecording);

function stopRecording() {
  if (!mediaRecorder) return;
  mediaRecorder.stop();
  activeStreams.forEach(s => s.getTracks().forEach(t => t.stop()));
  activeStreams = [];

  stopTimer();
  cancelAnimationFrame(animFrameId);
  clearCanvas();

  btnStop.disabled           = true;
  recTimerWrap.hidden        = true;
  btnRecord.classList.remove('recording');
  waveformIdle.style.display = '';
  setProcessing('Enviando áudio para transcrição...');
}

// ============================================================
//  Enviar e transcrever
// ============================================================
async function sendAudio(mimeType) {
  const ext  = mimeType.includes('ogg') ? '.ogg' : mimeType.includes('mp4') ? '.mp4' : '.webm';
  const blob = new Blob(audioChunks, { type: mimeType });
  const form = new FormData();
  form.append('audio', blob, `gravacao${ext}`);

  const selectedPrompt = getSelectedPrompt();

  try {
    setProcessing('Transcrevendo com IA...');
    const url = `/transcribe?speakers=${getSpeakers()}&prompt=${encodeURIComponent(selectedPrompt?.text || '')}`;
    const res = await fetch(url, { method: 'POST', body: form });

    if (!res.ok) {
      let detail = `Erro HTTP ${res.status}`;
      try { detail = (await res.json()).detail || detail; } catch {}
      throw new Error(detail);
    }

    const data = await res.json();
    renderResult(data);
  } catch (err) {
    console.error('[sendAudio]', err);
    const msg = err.message && err.message !== 'Failed to fetch'
      ? err.message
      : 'Não foi possível conectar ao servidor.\nVerifique se o servidor está rodando e tente novamente.';
    showError(msg);
    processingCard.hidden = true;
    btnRecord.disabled    = false;
  }
}

// ============================================================
//  Regenerar resumo
// ============================================================
btnRegenerateSum?.addEventListener('click', async () => {
  if (!lastFullText && !lastTranscriptId) return;

  const prompt = getSelectedPrompt();

  summaryList.innerHTML     = '';
  summaryBlock.hidden       = false;
  summaryEmpty.hidden       = true;
  summaryLoading.hidden     = false;
  btnRegenerateSum.disabled = true;

  try {
    const res = await fetch('/summarize', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text:          lastFullText,
        prompt:        prompt?.text || '',
        transcript_id: lastTranscriptId,
      }),
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.detail || `Erro ${res.status}`);
    }

    const data = await res.json();
    summaryLoading.hidden = true;
    renderSummary(data.summary || '');
  } catch (err) {
    summaryLoading.hidden = true;
    summaryEmpty.hidden   = false;
    showError(err.message || 'Não foi possível regenerar o resumo.');
  } finally {
    btnRegenerateSum.disabled = false;
  }
});

function renderSummary(text) {
  summaryList.innerHTML = '';
  if (!text) {
    summaryEmpty.hidden = false;
    summaryBlock.hidden = false;
    return;
  }
  text.split('\n').filter(l => l.trim()).forEach(line => {
    const li = document.createElement('li');
    li.textContent = line.replace(/^[-•]\s*/, '');
    summaryList.appendChild(li);
  });
  summaryEmpty.hidden = !!summaryList.children.length;
  summaryBlock.hidden = false;
}

// ============================================================
//  Renderizar resultado
// ============================================================
function renderResult(data) {
  processingCard.hidden   = true;
  resultCard.hidden       = false;
  utteranceList.innerHTML = '';
  speakerLegend.innerHTML = '';
  summaryList.innerHTML   = '';
  speakerSection.hidden   = true;
  summaryBlock.hidden     = false;
  summaryLoading.hidden   = true;
  summaryEmpty.hidden     = true;
  speakerNames            = new Map();

  const { utterances, full_text, summary, transcript_id } = data;

  lastTranscriptId = transcript_id || '';
  lastFullText     = full_text     || '';

  populatePromptSelects();

  if (summary) {
    summaryLoading.hidden  = true;
    renderSummary(summary);
  } else {
    summaryEmpty.hidden = false;
  }

  if (utterances && utterances.length > 0) {
    speakerSection.hidden = false;
    const colorMap = buildColorMap(utterances);
    const total    = utterances.length;
    const duration = utterances[total - 1]?.end_ms || 0;

    resultMeta.textContent =
      `${total} falas detectadas · ${colorMap.size} falante(s) · ${formatMs(duration)} de duração`;

    colorMap.forEach((color, speaker) => {
      const pill = document.createElement('div');
      pill.className        = 'legend-pill';
      pill.dataset.speaker  = speaker;
      pill.style.color      = color;
      pill.style.borderColor = hexToRgba(color, .25);
      pill.style.background  = hexToRgba(color, .07);
      pill.innerHTML = `
        <span class="legend-dot"></span>
        <span class="legend-name">Pessoa ${speaker}</span>
        <button class="rename-btn" title="Renomear falante">
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
            <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/>
            <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>
          </svg>
        </button>
      `;
      pill.querySelector('.rename-btn').addEventListener('click', () => startRename(speaker, color));
      speakerLegend.appendChild(pill);
    });

    utterances.forEach(u => {
      const color = colorMap.get(u.speaker) || SPEAKER_COLORS[0];
      const div   = document.createElement('div');
      div.className       = 'utterance';
      div.dataset.speaker = u.speaker;
      div.innerHTML = `
        <div class="utterance-left">
          <div class="utterance-speaker">
            <div class="speaker-avatar" style="background:${color}">${u.speaker}</div>
            <span class="speaker-name">Pessoa ${u.speaker}</span>
          </div>
          <div class="utterance-time">${formatMs(u.start_ms)}</div>
        </div>
        <div class="utterance-right">
          <div class="utterance-text">${escHtml(u.text)}</div>
        </div>
      `;
      utteranceList.appendChild(div);
    });
  } else if (full_text) {
    resultMeta.textContent = 'Transcricao sem identificacao de falantes';
  } else {
    resultMeta.textContent = 'Nenhum conteudo detectado no audio';
  }

  btnRecord.disabled = false;
  resultCard.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

// ============================================================
//  Ações do resultado
// ============================================================
btnDownload.addEventListener('click', () => {
  const lines = [];
  if (!summaryBlock.hidden) {
    lines.push('=== RESUMO ===');
    summaryList.querySelectorAll('li').forEach(li => lines.push(`• ${li.textContent}`));
    lines.push('');
    lines.push('=== TRANSCRIÇÃO ===');
  }
  document.querySelectorAll('.utterance').forEach(el => {
    const speaker = el.querySelector('.speaker-name').textContent.trim();
    const time    = el.querySelector('.utterance-time').textContent.trim();
    const text    = el.querySelector('.utterance-text').textContent.trim();
    lines.push(`[${time}] ${speaker}:\n${text}`);
  });
  downloadText(lines.join('\n\n'), 'transcricao.txt');
});

btnCopy.addEventListener('click', async () => {
  const lines = [];
  document.querySelectorAll('.utterance').forEach(el => {
    const speaker = el.querySelector('.speaker-name').textContent.trim();
    const text    = el.querySelector('.utterance-text').textContent.trim();
    lines.push(`${speaker}: ${text}`);
  });
  await navigator.clipboard.writeText(lines.join('\n\n'));
  const orig = btnCopy.innerHTML;
  btnCopy.textContent = '✓ Copiado!';
  setTimeout(() => { btnCopy.innerHTML = orig; }, 2000);
});

btnSave.addEventListener('click', async () => {
  const lines = [];
  if (!summaryBlock.hidden) {
    lines.push('=== RESUMO ===');
    summaryList.querySelectorAll('li').forEach(li => lines.push(`• ${li.textContent}`));
    lines.push('');
    lines.push('=== TRANSCRIÇÃO ===');
  }
  document.querySelectorAll('.utterance').forEach(el => {
    const speaker = el.querySelector('.speaker-name').textContent.trim();
    const time    = el.querySelector('.utterance-time').textContent.trim();
    const text    = el.querySelector('.utterance-text').textContent.trim();
    lines.push(`[${time}] ${speaker}:\n${text}`);
  });

  try {
    const res  = await fetch('/save', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: lines.join('\n\n') }),
    });
    const data = await res.json();
    const orig = btnSave.innerHTML;
    btnSave.textContent = `✓ Salvo: ${data.filename}`;
    setTimeout(() => { btnSave.innerHTML = orig; }, 3000);
  } catch {
    showError('Não foi possível salvar a transcrição no servidor.');
  }
});

btnClear.addEventListener('click', () => {
  resultCard.hidden       = true;
  utteranceList.innerHTML = '';
  speakerLegend.innerHTML = '';
  summaryList.innerHTML   = '';
  summaryBlock.hidden     = false;
  summaryLoading.hidden   = true;
  summaryEmpty.hidden     = false;
  lastTranscriptId        = '';
  lastFullText            = '';
  audioChunks             = [];
});

// ============================================================
//  Waveform
// ============================================================
function resizeCanvas() {
  const c = waveCanvas;
  const r = c.parentElement.getBoundingClientRect();
  c.width  = r.width  * devicePixelRatio;
  c.height = r.height * devicePixelRatio;
  c.style.width  = r.width  + 'px';
  c.style.height = r.height + 'px';
}

function drawWaveform() {
  if (!analyserNode) return;
  const c   = waveCanvas;
  const ctx = c.getContext('2d');
  const buf = new Uint8Array(analyserNode.frequencyBinCount);

  function frame() {
    animFrameId = requestAnimationFrame(frame);
    analyserNode.getByteTimeDomainData(buf);
    ctx.clearRect(0, 0, c.width, c.height);

    const grad = ctx.createLinearGradient(0, 0, c.width, 0);
    grad.addColorStop(0,   '#6c63ff');
    grad.addColorStop(0.5, '#a78bfa');
    grad.addColorStop(1,   '#f472b6');

    ctx.lineWidth   = 2.5 * devicePixelRatio;
    ctx.strokeStyle = grad;
    ctx.shadowBlur  = 12;
    ctx.shadowColor = '#6c63ff';
    ctx.beginPath();

    const step = c.width / buf.length;
    buf.forEach((v, i) => {
      const x = i * step;
      const y = (v / 128.0) * (c.height / 2);
      i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
    });

    ctx.stroke();
    ctx.shadowBlur = 0;
  }

  frame();
}

function clearCanvas() {
  const c   = waveCanvas;
  const ctx = c.getContext('2d');
  ctx.clearRect(0, 0, c.width, c.height);
}

// ============================================================
//  Timer
// ============================================================
function startTimer() {
  elapsedSecs = 0;
  updateTimer();
  timerInterval = setInterval(() => { elapsedSecs++; updateTimer(); }, 1000);
}

function stopTimer() {
  clearInterval(timerInterval);
  timerInterval = null;
}

function updateTimer() {
  const m = String(Math.floor(elapsedSecs / 60)).padStart(2, '0');
  const s = String(elapsedSecs % 60).padStart(2, '0');
  recTimer.textContent = `${m}:${s}`;
}

// ============================================================
//  Processando
// ============================================================
function setProcessing(msg) {
  processingCard.hidden        = false;
  processingTitle.textContent  = msg;
}

// ============================================================
//  Renomear falante
// ============================================================
function startRename(speakerId, color) {
  const pill     = speakerLegend.querySelector(`[data-speaker="${speakerId}"]`);
  const nameSpan = pill.querySelector('.legend-name');
  const current  = nameSpan.textContent;

  const input = document.createElement('input');
  input.className   = 'rename-input';
  input.value       = current;
  input.style.color = color;
  nameSpan.replaceWith(input);
  input.focus();
  input.select();

  function commit() {
    const newName = input.value.trim() || `Pessoa ${speakerId}`;
    renameSpeaker(speakerId, newName);
    const span = document.createElement('span');
    span.className   = 'legend-name';
    span.textContent = newName;
    input.replaceWith(span);
  }

  input.addEventListener('blur', commit);
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter')  input.blur();
    if (e.key === 'Escape') { input.value = current; input.blur(); }
  });
}

function renameSpeaker(speakerId, newName) {
  speakerNames.set(speakerId, newName);
  document.querySelectorAll(`.utterance[data-speaker="${speakerId}"] .speaker-name`).forEach(el => {
    el.textContent = newName;
  });
}

// ============================================================
//  Utils
// ============================================================
function buildColorMap(utterances) {
  const map = new Map();
  let i = 0;
  utterances.forEach(u => {
    if (!map.has(u.speaker)) map.set(u.speaker, SPEAKER_COLORS[i++ % SPEAKER_COLORS.length]);
  });
  return map;
}

function formatMs(ms) {
  if (ms == null) return '--:--';
  const t = Math.floor(ms / 1000);
  const m = String(Math.floor(t / 60)).padStart(2, '0');
  const s = String(t % 60).padStart(2, '0');
  return `${m}:${s}`;
}

function escHtml(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

function escAttr(s) {
  return String(s).replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/'/g,'&#39;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

function downloadText(text, filename) {
  const a    = document.createElement('a');
  a.href     = URL.createObjectURL(new Blob([text], { type: 'text/plain;charset=utf-8' }));
  a.download = filename;
  a.click();
}

function getSupportedMimeType() {
  const types = ['audio/webm;codecs=opus','audio/webm','audio/ogg;codecs=opus','audio/mp4'];
  return types.find(t => MediaRecorder.isTypeSupported(t)) || '';
}

// ============================================================
//  Erros amigáveis
// ============================================================
function friendlyError(err) {
  const name = err.name || '';
  const msg  = (err.message || '').toLowerCase();

  if (name === 'NotAllowedError' || msg.includes('permission denied') || msg.includes('denied by user')) {
    if (getSource() === 'mic')
      return 'Permissão do microfone negada.\nClique no ícone de cadeado na barra de endereço e permita o acesso ao microfone.';
    return 'Você cancelou o seletor de aba/janela.\nClique em "Iniciar Gravação" novamente e escolha qual aba capturar antes de confirmar.';
  }
  if (name === 'NotFoundError' || msg.includes('not found'))
    return 'Nenhum microfone encontrado.\nVerifique se há um microfone conectado ao computador.';
  if (msg.includes('nenhum áudio') || msg.includes('audio'))
    return 'A aba selecionada não está transmitindo áudio.\nCertifique-se de marcar "Compartilhar áudio da aba" no seletor.';

  return err.message || 'Erro desconhecido. Tente novamente.';
}

function showError(msg) {
  document.getElementById('errorToast')?.remove();

  const toast = document.createElement('div');
  toast.id = 'errorToast';
  toast.innerHTML = `
    <div style="
      position:fixed; bottom:28px; left:50%; transform:translateX(-50%);
      background:#1e1020; border:1px solid rgba(244,63,94,.4);
      border-radius:14px; padding:16px 20px; max-width:440px; width:90%;
      box-shadow:0 8px 40px rgba(0,0,0,.6);
      display:flex; gap:14px; align-items:flex-start;
      z-index:9999; animation:slideUp .2s ease;
    ">
      <div style="color:#f43f5e;font-size:20px;flex-shrink:0;margin-top:1px">⚠</div>
      <div>
        <div style="font-weight:700;font-size:14px;color:#f1f1f5;margin-bottom:4px">Erro</div>
        <div style="font-size:13px;color:#9ca3af;line-height:1.6;white-space:pre-line">${escHtml(msg)}</div>
      </div>
      <button onclick="this.closest('#errorToast').remove()" style="
        background:none;border:none;color:#6b7299;cursor:pointer;
        font-size:18px;padding:0;margin-left:auto;flex-shrink:0;line-height:1
      ">×</button>
    </div>
  `;
  document.body.appendChild(toast);
  setTimeout(() => toast.remove(), 8000);
}

const _toastStyle = document.createElement('style');
_toastStyle.textContent = `@keyframes slideUp { from { opacity:0; transform:translateX(-50%) translateY(16px); } to { opacity:1; transform:translateX(-50%) translateY(0); } }`;
document.head.appendChild(_toastStyle);

function hexToRgba(hex, alpha) {
  const r = parseInt(hex.slice(1,3),16);
  const g = parseInt(hex.slice(3,5),16);
  const b = parseInt(hex.slice(5,7),16);
  return `rgba(${r},${g},${b},${alpha})`;
}
