// ============================================================
//  MeetingScript — app.js
// ============================================================

const SPEAKER_COLORS = [
  '#6c63ff','#f43f5e','#22c55e','#f59e0b',
  '#38bdf8','#f472b6','#a3e635','#fb923c',
];

// ── Estado ──────────────────────────────────────────────────
let mediaRecorder  = null;
let audioChunks    = [];
let timerInterval  = null;
let elapsedSecs    = 0;
let activeStreams   = [];
let animFrameId    = null;
let analyserNode   = null;
let audioCtxGlobal = null;
let speakerNames   = new Map();

// ── Elementos ────────────────────────────────────────────────
const btnRecord       = document.getElementById('btnRecord');
const btnStop         = document.getElementById('btnStop');
const recTimerWrap    = document.getElementById('recTimerWrap');
const recTimer        = document.getElementById('recTimer');
const processingCard  = document.getElementById('processingCard');
const processingTitle = document.getElementById('processingTitle');
const resultCard      = document.getElementById('resultCard');
const resultMeta      = document.getElementById('resultMeta');
const speakerLegend   = document.getElementById('speakerLegend');
const utteranceList   = document.getElementById('utteranceList');
const fullTextBlock   = document.getElementById('fullTextBlock');
const fullText        = document.getElementById('fullText');
const apiStatus       = document.getElementById('apiStatus');
const apiStatusText   = document.getElementById('apiStatusText');
const tabBanner       = document.getElementById('tabBanner');
const waveCanvas      = document.getElementById('waveCanvas');
const waveformIdle    = document.getElementById('waveformIdle');
const btnDownload     = document.getElementById('btnDownload');
const btnCopy         = document.getElementById('btnCopy');
const btnClear        = document.getElementById('btnClear');
const btnSave         = document.getElementById('btnSave');
const summaryBlock    = document.getElementById('summaryBlock');
const summaryList     = document.getElementById('summaryList');

// ── Init ─────────────────────────────────────────────────────
checkApiHealth();
setupSourceListeners();
resizeCanvas();
window.addEventListener('resize', resizeCanvas);

// ============================================================
//  API Health
// ============================================================
async function checkApiHealth() {
  try {
    const res  = await fetch('/health');
    const data = await res.json();
    if (data.api_key_configured) {
      apiStatus.className    = 'api-badge ok';
      apiStatusText.textContent = 'API Conectada';
    } else {
      apiStatus.className    = 'api-badge err';
      apiStatusText.textContent = 'API Key ausente';
    }
  } catch {
    apiStatus.className    = 'api-badge err';
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

function getSource()    { return document.querySelector('input[name="source"]:checked').value; }
function getLang()      { return document.querySelector('input[name="lang"]:checked').value; }
function getSpeakers()  { return document.querySelector('input[name="speakers"]:checked')?.value || '0'; }

// ============================================================
//  Captura de áudio
// ============================================================
async function buildAudioStream(source) {
  const ctx         = new AudioContext();
  const destination = ctx.createMediaStreamDestination();

  // Analyser para o visualizador
  analyserNode        = ctx.createAnalyser();
  analyserNode.fftSize = 256;
  analyserNode.connect(destination);
  audioCtxGlobal = ctx;

  activeStreams = [];

  if (source === 'mic' || source === 'both') {
    const mic = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    activeStreams.push(mic);
    const src = ctx.createMediaStreamSource(mic);
    src.connect(analyserNode);
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
    const src = ctx.createMediaStreamSource(display);
    src.connect(analyserNode);

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

    // UI
    btnRecord.disabled     = true;
    btnRecord.classList.add('recording');
    btnStop.disabled       = false;
    recTimerWrap.hidden    = false;
    resultCard.hidden      = true;
    processingCard.hidden  = true;
    waveformIdle.style.display = 'none';

    startTimer();
    drawWaveform();
  } catch (err) {
    console.error(err);
    const msg = friendlyError(err);
    showError(msg);
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

  btnStop.disabled       = true;
  recTimerWrap.hidden    = true;
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

  try {
    setProcessing('Transcrevendo com IA...');
    const res = await fetch(`/transcribe?speakers=${getSpeakers()}`, { method: 'POST', body: form });

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
//  Renderizar resultado
// ============================================================
function renderResult(data) {
  processingCard.hidden  = true;
  resultCard.hidden      = false;
  utteranceList.innerHTML = '';
  speakerLegend.innerHTML = '';
  summaryList.innerHTML   = '';
  fullTextBlock.hidden    = true;
  summaryBlock.hidden     = true;
  speakerNames            = new Map();

  const { utterances, full_text, summary } = data;

  if (summary) {
    summaryBlock.hidden = false;
    summary.split('\n').filter(l => l.trim()).forEach(line => {
      const li = document.createElement('li');
      li.textContent = line.replace(/^[-•]\s*/, '');
      summaryList.appendChild(li);
    });
  }

  if (utterances && utterances.length > 0) {
    const colorMap = buildColorMap(utterances);
    const total    = utterances.length;
    const duration = utterances[total - 1]?.end_ms || 0;

    resultMeta.textContent =
      `${total} falas detectadas · ${colorMap.size} falante(s) · ${formatMs(duration)} de duração`;

    // Legenda com botão de renomear
    colorMap.forEach((color, speaker) => {
      const pill = document.createElement('div');
      pill.className = 'legend-pill';
      pill.dataset.speaker = speaker;
      pill.style.color = color;
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

    // Falas
    utterances.forEach(u => {
      const color = colorMap.get(u.speaker) || SPEAKER_COLORS[0];
      const div   = document.createElement('div');
      div.className = 'utterance';
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
    fullTextBlock.hidden = false;
    fullText.textContent = full_text;
    resultMeta.textContent = 'Transcrição sem identificação de falantes';
  } else {
    fullTextBlock.hidden = false;
    fullText.textContent = '(Nenhum conteúdo detectado no áudio)';
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
  if (!fullTextBlock.hidden) lines.push(fullText.textContent);
  downloadText(lines.join('\n\n'), 'transcricao.txt');
});

btnCopy.addEventListener('click', async () => {
  const lines = [];
  document.querySelectorAll('.utterance').forEach(el => {
    const speaker = el.querySelector('.speaker-name').textContent.trim();
    const text    = el.querySelector('.utterance-text').textContent.trim();
    lines.push(`${speaker}: ${text}`);
  });
  if (!fullTextBlock.hidden) lines.push(fullText.textContent);
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
  if (!fullTextBlock.hidden) lines.push(fullText.textContent);

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
  summaryBlock.hidden     = true;
  audioChunks = [];
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

    // Gradiente de linha
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
  processingCard.hidden  = false;
  processingTitle.textContent = msg;
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
    if (!map.has(u.speaker)) {
      map.set(u.speaker, SPEAKER_COLORS[i++ % SPEAKER_COLORS.length]);
    }
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
  return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
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
    const source = getSource();
    if (source === 'mic') {
      return 'Permissão do microfone negada.\nClique no ícone de cadeado na barra de endereço do navegador e permita o acesso ao microfone.';
    }
    return 'Você cancelou o seletor de aba/janela.\nClique em "Iniciar Gravação" novamente e escolha qual aba deseja capturar antes de confirmar.';
  }

  if (name === 'NotFoundError' || msg.includes('not found')) {
    return 'Nenhum microfone encontrado.\nVerifique se há um microfone conectado ao computador.';
  }

  if (msg.includes('nenhum áudio') || msg.includes('audio')) {
    return 'A aba selecionada não está transmitindo áudio.\nCertifique-se de marcar "Compartilhar áudio da aba" no seletor do navegador.';
  }

  return err.message || 'Erro desconhecido. Tente novamente.';
}

function showError(msg) {
  // Remove toast anterior se existir
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
        <div style="font-weight:700;font-size:14px;color:#f1f1f5;margin-bottom:4px">Erro na gravação</div>
        <div style="font-size:13px;color:#9ca3af;line-height:1.6;white-space:pre-line">${msg}</div>
      </div>
      <button onclick="this.closest('#errorToast').remove()" style="
        background:none;border:none;color:#6b7299;cursor:pointer;
        font-size:18px;padding:0;margin-left:auto;flex-shrink:0;line-height:1
      ">×</button>
    </div>
  `;
  document.body.appendChild(toast);

  // Fecha automaticamente após 7 segundos
  setTimeout(() => toast.remove(), 7000);
}

// Animação do toast
const style = document.createElement('style');
style.textContent = `@keyframes slideUp { from { opacity:0; transform:translateX(-50%) translateY(16px); } to { opacity:1; transform:translateX(-50%) translateY(0); } }`;
document.head.appendChild(style);

function hexToRgba(hex, alpha) {
  const r = parseInt(hex.slice(1,3),16);
  const g = parseInt(hex.slice(3,5),16);
  const b = parseInt(hex.slice(5,7),16);
  return `rgba(${r},${g},${b},${alpha})`;
}
