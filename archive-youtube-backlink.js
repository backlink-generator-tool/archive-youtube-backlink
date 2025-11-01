(() => {
  "use strict";

  // ---------- Elements ----------
  const el = {
    videoInput: document.getElementById('videoInput'),
    startStopBtn: document.getElementById('startStopBtn'),
    toggleAdvancedBtn: document.getElementById('toggleAdvancedBtn'),
    advancedPanel: document.getElementById('advancedPanel'),
    modeSelect: document.getElementById('modeSelect'),
    reuseToggle: document.getElementById('reuseToggle'),
    concurrencyRange: document.getElementById('concurrencyRange'),
    concurrencyCount: document.getElementById('concurrencyCount'),
    targetWayback: document.getElementById('targetWayback'),
    targetArchiveToday: document.getElementById('targetArchiveToday'),
    rerunCheckbox: document.getElementById('rerunCheckbox'),
    shuffleCheckbox: document.getElementById('shuffleCheckbox'),
    shareUrl: document.getElementById('shareUrl'),
    copyBtn: document.getElementById('copyBtn'),
    progressBar: document.getElementById('progressBar'),
    progressText: document.getElementById('progressText'),
    iframeGrid: document.getElementById('iframeGrid'),
    results: document.getElementById('results'),
    downloadBtn: document.getElementById('downloadBtn'),
    toast: document.getElementById('toast'),
  };

  // ---------- State ----------
  const STATE = {
    running:false,
    runToken:0,
    templates:[],
    backlinkList:[],
    taskQueue:[],
    concurrency:4,
    mode:'iframe',
    reuse:'fresh',
    done:0,
    total:0,
    slotIframes:[],
    slots:[],
    timers:new Set(),
    openWindows:new Set(),
  };

  // ---------- Settings (save/load) ----------
  const SETTINGS_KEY = 'ayvb_settings_v4';
  function saveSettings(){
    try{
      const settings = {
        mode: el.modeSelect.value,
        reuse: el.reuseToggle.value,
        concurrency: parseInt(el.concurrencyRange.value,10)||4,
        rerun: !!el.rerunCheckbox.checked,
        shuffle: !!el.shuffleCheckbox.checked,
        targets: {
          wayback: !!el.targetWayback.checked,
          archivetoday: !!el.targetArchiveToday.checked
        }
      };
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
    }catch(e){}
  }
  function loadSettings(){
    try{
      const raw = localStorage.getItem(SETTINGS_KEY);
      if(!raw) return null;
      const s = JSON.parse(raw);
      return s && typeof s==='object' ? s : null;
    }catch(e){ return null; }
  }
  function applySettingsToUI(s){
    if(!s) return;
    if(s.mode) el.modeSelect.value = s.mode;
    if(s.reuse) el.reuseToggle.value = s.reuse;
    if(Number.isFinite(+s.concurrency)){
      el.concurrencyRange.value = String(s.concurrency);
      el.concurrencyCount.textContent = String(s.concurrency);
    }
    el.rerunCheckbox.checked = !!s.rerun;
    el.shuffleCheckbox.checked = s.shuffle !== false;
    if (s.targets){
      el.targetWayback.checked     = s.targets.wayback !== false;
      el.targetArchiveToday.checked= s.targets.archivetoday !== false;
    }
    updateReuseAvailability();
  }

  // ---------- Small helpers ----------
  const sleep = (ms)=>new Promise(r=>{
    const id=setTimeout(()=>{STATE.timers.delete(id); r();},ms);
    STATE.timers.add(id);
  });
  function clearTimers(){ for(const id of [...STATE.timers]){ clearTimeout(id); STATE.timers.delete(id); } }
  function showToast(msg,ms=2200){ el.toast.textContent=msg; el.toast.classList.add('show'); const id=setTimeout(()=>{ el.toast.classList.remove('show'); STATE.timers.delete(id); },ms); STATE.timers.add(id); }
  function updateProgress(){ const pct=STATE.total?Math.round(STATE.done/STATE.total*100):0; el.progressBar.style.width=pct+'%'; el.progressText.textContent=`${STATE.done}/${STATE.total} (${pct}%)`; }

  // ---------- YouTube parsing ----------
  const YT_ID_RE=/^[a-zA-Z0-9_-]{11}$/;
  function extractVideoId(input){
    if(!input) return null;
    input=input.trim();
    if(YT_ID_RE.test(input)) return input;
    try{
      const u=new URL(input);
      if(u.hostname.includes('youtube.com')||u.hostname.includes('youtu.be')){
        const v=u.searchParams.get('v'); if(v&&YT_ID_RE.test(v)) return v;
        const pathId=u.pathname.split('/').filter(Boolean)[0]; if(pathId&&YT_ID_RE.test(pathId)) return pathId;
      }
    }catch{}
    return null;
  }
  const canonicalUrl=id=>`https://www.youtube.com/watch?v=${id}`;
  const shortUrl=id=>`https://youtu.be/${id}`;

  // ---------- Template expansion ----------
  function expandTemplate(tpl,id){
    const url=canonicalUrl(id); const short=shortUrl(id);
    const reps=[
      {re:/\[VIDEO_ID\]|\[ID\]|\{ID\}|\{id\}|\{\{ID\}\}/gi, val:id},
      {re:/\[VIDEO_URL\]|\[URL\]|\{URL\}|\{url\}|\{\{URL\}\}/gi, val:url},
      {re:/\[SHORT_URL\]|\{SHORT_URL\}/gi, val:short},
      {re:/\[ENCODE_URL\]|\{ENCODE_URL\}/gi, val:encodeURIComponent(url)}
    ];
    let out=String(tpl); for(const r of reps){ out=out.replace(r.re,r.val); }
    return out;
  }

  // ---------- Archive wrappers ----------
  function wrapForWayback(backlink){ return 'https://web.archive.org/save/' + encodeURIComponent(backlink); }
  const ARCHIVE_TODAY_TLDS = ["archive.today","archive.li","archive.vn","archive.fo","archive.md","archive.ph","archive.is"];
  function wrapForArchiveToday(backlink, host){ return `https://${host}/submit/?anyway=1&url=${encodeURIComponent(backlink)}`; }
  function pickRandomTodayHost(){ return ARCHIVE_TODAY_TLDS[Math.floor(Math.random()*ARCHIVE_TODAY_TLDS.length)]; }

  // ---------- Build tasks (Wayback + one random archive.today TLD per backlink) ----------
  function buildTasksFromTemplates(id){
    const originals=[];
    for(const raw of STATE.templates){
      const tpl = typeof raw==='string'?raw : (raw && (raw.url||raw.template));
      if(!tpl) continue;
      originals.push( expandTemplate(tpl,id) );
    }
    if(el.shuffleCheckbox.checked) originals.sort(()=>Math.random()-0.5);
    STATE.backlinkList = originals.slice();

    const tasks=[];
    const useWayback     = !!el.targetWayback.checked;
    const useArchiveToday= !!el.targetArchiveToday.checked;

    for (let i=0;i<originals.length;i++){
      const bk = originals[i];
      if (useWayback)   tasks.push({i, target:'wayback',   label:'Wayback',        backlinkUrl:bk, archiveUrl:wrapForWayback(bk)});
      if (useArchiveToday){
        const host = pickRandomTodayHost();
        tasks.push({i, target:'archivetoday', label:host, host, backlinkUrl:bk, archiveUrl:wrapForArchiveToday(bk, host)});
      }
    }
    return tasks;
  }

  // ---------- IFrame grid ----------
  function buildIframeSlots(n){
    clearIframeSlots();
    STATE.slotIframes=[];
    for(let i=0;i<n;i++){
      const card=document.createElement('div'); card.className='slot';
      const head=document.createElement('header'); const tag=document.createElement('div'); tag.className='tag'; tag.textContent=`Slot ${i+1}`;
      head.appendChild(tag);
      const frame=document.createElement('iframe'); frame.setAttribute('title',`Archive slot ${i+1}`);
      card.appendChild(head); card.appendChild(frame);
      el.iframeGrid.appendChild(card);
      STATE.slotIframes.push(frame);
    }
  }
  function clearIframeSlots(){ STATE.slotIframes=[]; el.iframeGrid.innerHTML=''; }

  // ---------- Results ----------
  function addResult(href, label){
    const li=document.createElement('li');
    li.innerHTML = `<a href="${href}" target="_blank" rel="noopener">[${label}] ${href}</a> <span class="status loading">⏳</span>`;
    el.results.appendChild(li);
    return li.querySelector('.status');
  }
  function markStatus(span,ok){ span.classList.remove('loading','success','failure'); span.classList.add(ok?'success':'failure'); span.textContent= ok?'✔️':'✖️'; }

  // ---------- Mode helpers ----------
  function updateReuseAvailability(){
    const isIframe = el.modeSelect.value === 'iframe';
    el.reuseToggle.disabled = isIframe;
    el.reuseToggle.ariaDisabled = String(isIframe);
  }

  // ---------- Run control ----------
  async function startRun(){
    const raw=el.videoInput.value.trim();
    const id=extractVideoId(raw);
    if(!id){ showToast('Please paste a valid YouTube link or 11-char ID.'); return; }

    // Save settings on start
    saveSettings();

    // Ensure at least one archive target
    if(!el.targetWayback.checked && !el.targetArchiveToday.checked){
      showToast('Please select at least one archive target.');
      return;
    }

    // Shareable URL (?VIDEOID)
    const share = `${location.origin}${location.pathname}?${id}`;
    el.shareUrl.value = share; history.replaceState(null,'',`?${id}`);

    STATE.mode = el.modeSelect.value;
    STATE.reuse = el.reuseToggle.value;
    STATE.concurrency = parseInt(el.concurrencyRange.value,10)||4;

    STATE.taskQueue = buildTasksFromTemplates(id);
    STATE.total = STATE.taskQueue.length;
    STATE.done = 0; updateProgress();

    STATE.running=true; STATE.runToken++; const myRun=STATE.runToken;
    el.startStopBtn.textContent='Stop'; el.startStopBtn.setAttribute('aria-pressed','true');
    el.results.innerHTML='';

    if (STATE.mode==='iframe'){
      el.iframeGrid.style.display=''; buildIframeSlots(STATE.concurrency);
    } else {
      el.iframeGrid.style.display='none'; clearIframeSlots();
    }

    STATE.slots = Array.from({length:STATE.concurrency},(_,i)=>({id:i, ref:null}));
    await Promise.all(STATE.slots.map(s=>workerLoop(s,myRun)));

    if (STATE.runToken!==myRun) return;
    STATE.running=false; el.startStopBtn.textContent='Start'; el.startStopBtn.setAttribute('aria-pressed','false');

    if (el.rerunCheckbox.checked){
      await sleep(500);
      if (STATE.runToken===myRun){ startRun(); }
    }
  }

  async function workerLoop(slot,myRun){
    while(STATE.runToken===myRun){
      const task = STATE.taskQueue.shift();
      if(!task) break;

      const statusEl = addResult(task.archiveUrl, task.label);
      const ok = await runOneTask(slot, task);
      markStatus(statusEl, ok);

      STATE.done++; updateProgress();
    }
  }

  function runOneTask(slot, task){
    const HARD = 180000; // 3 min

    return new Promise((resolve)=>{
      let finished=false;
      const finish=(ok)=>{ if(finished) return; finished=true; resolve(ok); };

      const toId = setTimeout(()=>{ clearTimeout(toId); finish(false); }, HARD);

      if (STATE.mode === 'iframe'){
        const frame = STATE.slotIframes[slot.id];
        if(!frame){ clearTimeout(toId); return finish(false); }
        const onload=()=>{ frame.removeEventListener('load', onload, true); clearTimeout(toId); finish(true); };
        frame.addEventListener('load', onload, true);
        try{ frame.src = task.archiveUrl; }catch{} 
        return;
      }

      // Popup / Tab: fresh vs reuse
      const isPopup = STATE.mode==='popup';
      const specs = isPopup ? 'width=980,height=720' : '';
      const reuse = STATE.reuse === 'reuse';

      if (reuse){
        if (!slot.ref || slot.ref.closed){
          try{
            slot.ref = window.open('about:blank', 'slot-'+slot.id, specs);
            if (!slot.ref){ clearTimeout(toId); return finish(false); }
            STATE.openWindows.add(slot.ref);
          }catch{ clearTimeout(toId); return finish(false); }
        }
        let loaded=false;
        try{ slot.ref.onload = ()=>{ loaded=true; }; }catch{}
        try{ slot.ref.location.href = task.archiveUrl; }catch{}
        const waitId = setTimeout(()=>{
          clearTimeout(waitId);
          try{
            const t = slot.ref.document ? (slot.ref.document.title||'') : '';
            if (t.trim().toLowerCase()==='welcome to nginx'){ clearTimeout(toId); return finish(false); }
            clearTimeout(toId); return finish(true);
          }catch(e){
            clearTimeout(toId); return finish(true);
          }
        }, 8000);
        return;
      } else {
        let w=null, opened=false;
        try{
          w = window.open('about:blank', '_blank', specs);
          if (w){ opened=true; STATE.openWindows.add(w); }
        }catch{}
        if (!opened){ clearTimeout(toId); return finish(false); }

        let loaded=false;
        try{ w.onload = ()=>{ loaded=true; }; }catch{}
        try{ w.location.href = task.archiveUrl; }catch{}
        const waitId = setTimeout(()=>{
          clearTimeout(waitId);
          try{
            const t = w.document ? (w.document.title||'') : '';
            const ok = (t.trim().toLowerCase()!=='welcome to nginx');
            try{ w.close(); }catch{}
            STATE.openWindows.delete(w);
            clearTimeout(toId); return finish(ok);
          }catch(e){
            try{ w.close(); }catch{}
            STATE.openWindows.delete(w);
            clearTimeout(toId); return finish(true);
          }
        }, 8000);
        return;
      }
    });
  }

  async function stopRun(){
    STATE.runToken++;
    STATE.running=false;
    clearTimers();

    for (const w of [...STATE.openWindows]){
      try{ w.close(); }catch{}
      STATE.openWindows.delete(w);
    }
    clearIframeSlots();

    el.startStopBtn.textContent='Start';
    el.startStopBtn.setAttribute('aria-pressed','false');
  }

  // ---------- Events ----------
  el.toggleAdvancedBtn.addEventListener('click', ()=>{
    const shown = el.advancedPanel.style.display !== 'none';
    const next = shown ? 'none' : 'block';
    el.advancedPanel.style.display = next;
    el.toggleAdvancedBtn.setAttribute('aria-expanded', next==='block' ? 'true':'false');
    el.advancedPanel.setAttribute('aria-hidden', next==='block' ? 'false':'true');
  });

  el.modeSelect.addEventListener('change', ()=>{
    updateReuseAvailability();
    saveSettings();
  });
  el.reuseToggle.addEventListener('change', saveSettings);
  el.concurrencyRange.addEventListener('input', ()=>{
    el.concurrencyCount.textContent = el.concurrencyRange.value;
  });
  el.concurrencyRange.addEventListener('change', saveSettings);
  el.rerunCheckbox.addEventListener('change', saveSettings);
  el.shuffleCheckbox.addEventListener('change', saveSettings);
  el.targetWayback.addEventListener('change', saveSettings);
  el.targetArchiveToday.addEventListener('change', saveSettings);

  el.copyBtn.addEventListener('click', async ()=>{
    const txt = el.shareUrl.value.trim();
    if (!txt) return showToast('Nothing to copy');
    try{ await navigator.clipboard.writeText(txt); showToast('Share link copied!'); }
    catch{ el.shareUrl.select(); document.execCommand('copy'); showToast('Share link copied!'); }
  });

  el.downloadBtn.addEventListener('click', ()=>{
    if(!STATE.backlinkList.length) return showToast('No backlinks to download yet.');
    const blob=new Blob([STATE.backlinkList.join('\n')],{type:'text/plain;charset=utf-8'});
    const url=URL.createObjectURL(blob);
    const a=document.createElement('a'); a.href=url; a.download='backlinks.txt'; document.body.appendChild(a); a.click(); URL.revokeObjectURL(url); a.remove();
  });

  el.startStopBtn.addEventListener('click', ()=>{
    if (STATE.running) { stopRun(); return; }
    startRun();
  });

  // ---------- Templates fetch ----------
  async function loadTemplates(){
    try{
      const r = await fetch('https://backlink-generator-tool.github.io/backlink-generator-tool/youtube-backlink-templates.json',{cache:'no-store'});
      if(!r.ok) throw new Error(r.status);
      const data = await r.json();
      if(!Array.isArray(data)||!data.length) throw new Error('Empty template list');
      STATE.templates = data;
    }catch(e){
      STATE.templates = [];
      el.startStopBtn.disabled=true; el.startStopBtn.style.opacity=.6;
      showToast('Failed to load templates. Start is disabled.');
    }
  }

  // ---------- Shareable inbound ----------
  function parseInbound(){
    const q = window.location.search;
    if(!q || q.length<2) return null;
    return decodeURIComponent(q.slice(1));
  }
  async function initFromShare(){
    const inbound = parseInbound();
    if(!inbound) return;
    const id = extractVideoId(inbound);
    if(!id) return;
    el.videoInput.value = canonicalUrl(id);
    el.shareUrl.value = `${location.origin}${location.pathname}?${id}`;
    await startRun();
  }

  // ---------- Boot ----------
  (async function boot(){
    // defaults
    el.modeSelect.value='iframe';
    el.reuseToggle.value='fresh';
    el.concurrencyRange.value='4';
    el.concurrencyCount.textContent='4';
    el.shuffleCheckbox.checked = true;
    el.rerunCheckbox.checked = false;
    el.targetWayback.checked = true;
    el.targetArchiveToday.checked = true;

    // load saved settings
    applySettingsToUI(loadSettings());
    updateReuseAvailability();

    await loadTemplates();
    await initFromShare();

    if(!STATE.running) el.videoInput.focus({preventScroll:true});
  })();

})();
