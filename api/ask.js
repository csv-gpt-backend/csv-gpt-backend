<!doctype html>
<html lang="es">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Asistente (Wix + Vercel)</title>
  <style>
    :root{ --bg:#0b0c0f; --card:#12141a; --muted:#7f8ba3; --text:#e6e9f2; --accent:#3da9fc; --ok:#35c46a; --warn:#f7b801; --err:#ff6b6b; }
    html,body{ height:100%; margin:0; background:var(--bg); color:var(--text); font:400 14px/1.45 system-ui,Segoe UI,Roboto,Arial,sans-serif; }
    *{ box-sizing:border-box }
    .wrap{ width:100%; max-width:980px; margin:0 auto; padding:12px; }

    .card{ background:var(--card); border-radius:12px; padding:12px; box-shadow:0 4px 14px rgba(0,0,0,.35); }
    .row{ display:flex; gap:8px; align-items:center; flex-wrap:wrap; }
    label{ color:var(--muted); font-size:12px; }
    input[type="text"], textarea, select{
      width:100%; background:#0d0f14; color:var(--text); border:1px solid #1e2230; border-radius:10px; padding:10px 12px; outline:none;
    }
    textarea{ min-height:84px; resize:vertical }
    .btn{ appearance:none; border:1px solid #1e2230; background:#0f1219; color:var(--text); padding:10px 14px; border-radius:10px; cursor:pointer; white-space:nowrap; }
    .btn:hover{ border-color:#2a3247 }
    .btn[disabled]{ opacity:.55; cursor:not-allowed }
    .btn.primary{ border-color:transparent; background:linear-gradient(180deg,#2f94ff,#1677d8); }
    .btn.ok{ background:linear-gradient(180deg,#3fd37a,#299d58); border-color:transparent }
    .btn.stop{ background:linear-gradient(180deg,#ff7676,#e63946); border-color:transparent }

    .hint{ color:var(--muted); font-size:12px; }

    .status{ margin-top:8px; font-size:13px; }
    .status.ok{ color:var(--ok) }
    .status.warn{ color:var(--warn) }
    .status.err{ color:var(--err) }

    .answer{ margin-top:12px; background:#0d0f14; border:1px solid #1e2230; border-radius:12px; padding:12px; min-height:120px; overflow:auto; }
    .answer p{ margin:0 0 .6em }
    .answer code, .answer pre{ background:#0c0f14; border:1px solid #1e2230; padding:2px 6px; border-radius:6px; }

    .toolbar{ display:flex; gap:8px; flex-wrap:wrap; }
    .grow{ flex:1 1 auto }

    .sr-only{ position:absolute; width:1px; height:1px; padding:0; margin:-1px; overflow:hidden; clip:rect(0,0,0,0); white-space:nowrap; border:0; }

    #overlayFix{ display:none; position:static; pointer-events:none; z-index:auto; }
  </style>
</head>
<body>
  <div class="wrap">
    <h1 class="sr-only">Asistente de preguntas con voz</h1>

    <div class="card" aria-label="Conexión">
      <div class="row">
        <div class="grow">
          <label for="endpoint">Endpoint</label>
          <input id="endpoint" type="text" value="https://csv-gpt-backend.vercel.app/api/ask" spellcheck="false" />
        </div>
        <div>
          <label><input id="debug" type="checkbox" /> &nbsp;debug=1</label>
        </div>
      </div>
      <div class="hint">Atajos: <kbd>Enter</kbd> = Preguntar • <kbd>Ctrl</kbd>+<kbd>M</kbd> = Mic on/off</div>
    </div>

    <div class="card" style="margin-top:10px" aria-label="Pregunta">
      <div class="row">
        <textarea id="q" placeholder="Escribe o dicta tu pregunta…"></textarea>
      </div>
      <div class="row toolbar" style="margin-top:8px">
        <div class="grow"></div>
        <button id="askBtn" class="btn primary">Enviar</button>
        <button id="micStartBtn" class="btn ok">🎙️ Dictar</button>
        <button id="micStopBtn" class="btn stop" disabled>Detener</button>
        <button id="clearBtn" class="btn">Limpiar</button>
        <button id="copyBtn" class="btn">Copiar</button>
      </div>
      <div class="row" style="margin-top:8px">
        <div class="grow">
          <label for="voiceSelect">Voz TTS</label>
          <select id="voiceSelect"></select>
        </div>
        <div style="width:220px">
          <label for="sourceSelect">Fuente</label>
          <select id="sourceSelect">
            <option value="ambos" selected>Ambos</option>
            <option value="import1">Décimo A</option>
            <option value="import2">Décimo B</option>
          </select>
        </div>
      </div>

      <div id="status" class="status" role="status" aria-live="polite"></div>
      <div id="answer" class="answer" aria-live="polite"></div>
    </div>

    <div id="overlayFix"></div>
  </div>

<script>
(() => {
  const $ = (s, p=document) => p.querySelector(s);
  const endpoint = $('#endpoint');
  const debug = $('#debug');
  const q = $('#q');
  const answer = $('#answer');
  const statusEl = $('#status');
  const askBtn = $('#askBtn');
  const micStartBtn = $('#micStartBtn'); 
  const micStopBtn = $('#micStopBtn');
  const copyBtn = $('#copyBtn');
  const clearBtn = $('#clearBtn');
  const sourceSelect = $('#sourceSelect');
  const voiceSelect = $('#voiceSelect');

  // ===== Utilidades UI =====
  const setStatus = (msg, type='') => {
    statusEl.className = 'status ' + (type||'');
    statusEl.textContent = msg || '';
  };
  const renderText = (txt) => {
    const safe = String(txt).replace(/[<>&]/g, m => ({'<':'&lt;','>':'&gt;','&':'&amp;'}[m]));
    const blocks = safe.split(/\n{2,}/).map(b => `<p>${b.replace(/\n/g,'<br>')}</p>`).join('');
    answer.innerHTML = blocks || '<p class="hint">(sin contenido)</p>';
    answer.scrollTop = answer.scrollHeight;
  };

  // ===== Abort de peticiones =====
  let currentController = null;
  const abortInFlight = () => { try { currentController?.abort(); } catch(_e){} };

  // ===== TTS (con selector) =====
  let chosenVoice = null;
  function loadVoices(){
    const voices = (speechSynthesis.getVoices && speechSynthesis.getVoices()) || [];
    voiceSelect.innerHTML = '';
    const frag = document.createDocumentFragment();
    const makeOpt = (v, idx) => {
      const o = document.createElement('option');
      o.value = String(idx);
      o.textContent = `${v.name} — ${v.lang}`;
      return o;
    };
    // Orden: español primero
    const es = voices.filter(v => (v.lang||'').toLowerCase().startsWith('es'));
    const others = voices.filter(v => !(v.lang||'').toLowerCase().startsWith('es'));
    const list = [...es, ...others];
    list.forEach((v, i) => frag.appendChild(makeOpt(v, i)));
    voiceSelect.appendChild(frag);

    // Elegir voz femenina/español si existe
    let bestIdx = 0;
    for (let i=0;i<list.length;i++){
      const v = list[i];
      if (/(female|mujer|sabina|lola|helena|lucia|paulina|laura|monica)/i.test(v.name)) { bestIdx = i; break; }
    }
    voiceSelect.selectedIndex = bestIdx;
    chosenVoice = list[bestIdx] || voices[0] || null;
  }
  function speak(text) {
    if (!('speechSynthesis' in window)) return;
    const voices = (speechSynthesis.getVoices && speechSynthesis.getVoices()) || [];
    const idx = Number(voiceSelect.value);
    const list = [...voices.filter(v => (v.lang||'').toLowerCase().startsWith('es')), ...voices.filter(v => !(v.lang||'').toLowerCase().startsWith('es'))];
    chosenVoice = list[idx] || list[0] || null;

    const utt = new SpeechSynthesisUtterance(String(text));
    if (chosenVoice) { utt.voice = chosenVoice; utt.lang = chosenVoice.lang; } else { utt.lang = 'es-ES'; }
    utt.rate = 1.0; utt.pitch = 1.0;
    try { speechSynthesis.cancel(); } catch(_){}
    speechSynthesis.speak(utt);
  }
  if ('speechSynthesis' in window) {
    try { window.speechSynthesis.onvoiceschanged = loadVoices; } catch(_){}
    setTimeout(loadVoices, 50);
  } else {
    voiceSelect.disabled = true;
  }

  // ===== Speech Recognition =====
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  let rec = null;
  let recActive = false;
  function initSR(){
    if (!SR) return null;
    const r = new SR();
    r.lang = 'es-ES';
    r.interimResults = true;
    r.continuous = true;
    let base = q.value;
    r.onstart = () => { base = q.value; recActive = true; micStartBtn.disabled = true; micStopBtn.disabled = false; setStatus('Dictando… (habla y verás el texto en tiempo real)', 'ok'); };
    r.onerror = (ev) => { setStatus('Error de micrófono: ' + (ev.error||'desconocido'), 'err'); };
    r.onend = () => { recActive = false; micStartBtn.disabled = false; micStopBtn.disabled = true; setStatus('Dictado detenido.',''); };
    r.onresult = (ev) => {
      let finalTxt = '';
      let interim = '';
      for (let i = ev.resultIndex; i < ev.results.length; i++){
        const res = ev.results[i];
        if (res.isFinal) finalTxt += res[0].transcript;
        else interim += res[0].transcript;
      }
      q.value = (base + ' ' + finalTxt + ' ' + interim).trim();
    };
    return r;
  }
  if (SR) {
    rec = initSR();
  } else {
    micStartBtn.disabled = true;
    micStopBtn.disabled = true;
    micStartBtn.title = 'El dictado no está disponible en este navegador';
    setStatus('Dictado no disponible. Usa Chrome de escritorio si es posible.', 'warn');
  }

  function startMic(){ if (!rec) return; try { rec.start(); } catch(_){} }
  function stopMic(){ try { rec?.stop(); } catch(_){} }

  // ===== Helper: detectar "promedio de X" en el texto para forzar fast lane =====
  function parseMeanMetricFromText(txt){
    const s = String(txt||'').toLowerCase();
    if (!/(promedio|media|average)/i.test(s)) return null;
    const m = s.match(/promedio\s+de\s+([a-záéíóúñ_\s-]+)/i) || s.match(/de\s+([a-záéíóúñ_\s-]+)/i);
    if (m && m[1]){
      return m[1].trim().replace(/\s+/g,' ').toUpperCase();
    }
    return null;
  }

  // ===== Llamada al backend =====
  async function ask(){
    const query = q.value.trim();
    if (!query) { setStatus('Escribe o dicta una pregunta primero.','warn'); return; }
    abortInFlight();
    const ctl = new AbortController();
    currentController = ctl;

    const base = (endpoint.value||'').trim().replace(/\/$/, '');
    let url = '';
    try {
      const u = new URL(base);
      u.searchParams.set('q', query);
      const src = (sourceSelect.value||'ambos');
      if (src) u.searchParams.set('source', src);
      const metricAuto = parseMeanMetricFromText(query);
      if (metricAuto){ u.searchParams.set('metric', metricAuto); u.searchParams.set('op','mean'); }
      if (debug.checked) u.searchParams.set('debug', '1');
      url = u.toString();
    } catch {
      const parts = [ base + '?q=' + encodeURIComponent(query) ];
      const src = (sourceSelect.value||'ambos');
      if (src) parts.push('source=' + encodeURIComponent(src));
      const metricAuto = parseMeanMetricFromText(query);
      if (metricAuto){ parts.push('metric=' + encodeURIComponent(metricAuto)); parts.push('op=mean'); }
      if (debug.checked) parts.push('debug=1');
      url = parts.join('&');
    }

    setStatus('Consultando…', '');
    askBtn.disabled = true;

    let resp, data, text;
    try {
      resp = await fetch(url, { signal: ctl.signal, headers: { 'Accept':'application/json' } });
      const ct = resp.headers.get('content-type')||'';
      if (ct.includes('application/json')) data = await resp.json(); else text = await resp.text();
      if (!resp.ok){
        const body = data ? JSON.stringify(data).slice(0,800) : String(text||'').slice(0,800);
        setStatus(`Error ${resp.status}`, 'err');
        renderText(body || '(sin detalle)');
        return;
      }
    } catch (err) {
      if (err.name === 'AbortError') { setStatus('Consulta cancelada','warn'); return; }
      setStatus('Fallo de red: ' + (err.message||'desconocido'), 'err');
      return;
    } finally { askBtn.disabled = false; }

    const out = parseBackendPayload({data, text});
    renderText(out.view);
    if (out.toSpeak) speak(out.toSpeak);
    setStatus('Listo ✓','ok');
  }

  function parseBackendPayload({data, text}){
    if (typeof data === 'string') return { view: data, toSpeak: data };
    if (text && !data) return { view: text, toSpeak: text };
    let ans = '';
    if (data) { ans = data.answer || data.text || data.result || data.message || ''; if (!ans) ans = JSON.stringify(data, null, 2); }
    const toSpeak = (typeof ans === 'string' ? ans : '');
    return { view: ans, toSpeak };
  }

  // ===== Eventos =====
  askBtn.addEventListener('click', ask);
  clearBtn.addEventListener('click', () => { q.value=''; answer.innerHTML=''; setStatus('',''); });
  copyBtn.addEventListener('click', async () => {
    const tmp = answer.innerText.trim();
    if (!tmp) { setStatus('Nada para copiar.','warn'); return; }
    try { await navigator.clipboard.writeText(tmp); setStatus('Respuesta copiada.','ok'); } catch { setStatus('No se pudo copiar.','warn'); }
  });

  micStartBtn.addEventListener('click', startMic);
  micStopBtn.addEventListener('click', stopMic);
  q.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); ask(); } });
  document.addEventListener('keydown', (e) => { if (e.ctrlKey && String(e.key).toLowerCase() === 'm'){ if (recActive) stopMic(); else startMic(); } });

  const overlay = document.getElementById('overlayFix'); if (overlay){ overlay.style.display='none'; overlay.style.pointerEvents='none'; overlay.style.zIndex='auto'; }
})();
</script>
</body>
</html>
