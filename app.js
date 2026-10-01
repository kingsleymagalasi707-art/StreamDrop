const $=s=>document.querySelector(s);
const url=$('#url'), result=$('#result'), historyList=$('#historyList');

function validDirect(u){try{const x=new URL(u);return ['http:','https:'].includes(x.protocol)}catch{return false}}
function loadHistory(){
  const h=JSON.parse(localStorage.getItem('streamdrop-history')||'[]');
  if(!h.length){historyList.innerHTML='<div class="empty">No downloads yet.</div>';return}
  historyList.innerHTML=h.map(x=>`<div class="history-item"><div><strong>${escapeHtml(x.name)}</strong><br><small>${escapeHtml(x.type)} • ${escapeHtml(x.quality)} • ${new Date(x.date).toLocaleString()}</small></div><small>${escapeHtml(x.url.slice(0,55))}</small></div>`).join('');
}
function escapeHtml(s){return String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[c]))}
$('#pasteBtn').onclick=async()=>{try{url.value=await navigator.clipboard.readText();url.focus()}catch{url.focus()}};
async function analyzeWithBackend(raw){
  const panel=document.getElementById('linkValidation');
  if(panel){
    panel.hidden=false;
    panel.className='validation-panel checking';
    document.getElementById('validationTitle').textContent='Checking link…';
    document.getElementById('validationMessage').textContent='Veyra is validating the source and checking available media details.';
    document.getElementById('validationDetails').innerHTML='';
  }
  try{
    const response=await fetch('/api/analyze',{
      method:'POST',
      headers:{'Content-Type':'application/json','Accept':'application/json'},
      body:JSON.stringify({url:raw})
    });
    const data=await response.json();
    if(!response.ok || !data.supported) throw new Error(data.error||'This link is not supported.');

    if(panel){
      panel.className='validation-panel success';
      document.getElementById('validationTitle').textContent='Link supported';
      document.getElementById('validationMessage').textContent=data.note||'Media detected and ready for download.';
      document.getElementById('validationDetails').innerHTML=[
        data.type ? `${data.type}` : '',
        data.format ? `Format: ${String(data.format).toUpperCase()}` : '',
        data.size ? `Size: ${data.size}` : 'Size: Unknown',
        data.qualities?.length ? `Quality: ${data.qualities.join(', ')}` : ''
      ].filter(Boolean).map(x=>`<span class="validation-chip">${escapeHtml(x)}</span>`).join('');
    }

    $('#videoTitle').textContent=data.title||'Your media';
    $('#videoMeta').textContent=`${data.type||'Media'} • ${data.format?.toUpperCase()||'Detected'}${data.size?' • '+data.size:''}`;
    const meta=$('#mediaMeta');
    if(meta){
      meta.hidden=false;
      $('#detectedType').textContent=data.type||'—';
      $('#detectedSize').textContent=data.size||'Unknown';
      $('#detectedFormats').textContent=(data.formats||[]).join(', ')||'—';
    }

    const quality=$('#quality');
    const qualityGrid=document.querySelector('.quality-grid');
    if(quality && qualityGrid){
      const available=data.qualities?.length?data.qualities:['Original'];
      quality.innerHTML=available.map(q=>`<option value="${escapeHtml(q)}">${escapeHtml(q)}</option>`).join('');
      qualityGrid.innerHTML=available.map((q,i)=>`<button type="button" class="quality-chip ${i===0?'active':''}" data-quality="${escapeHtml(q)}">${escapeHtml(q)}</button>`).join('');
      document.querySelectorAll('.quality-chip').forEach(btn=>btn.onclick=()=>{
        document.querySelectorAll('.quality-chip').forEach(x=>x.classList.remove('active'));
        btn.classList.add('active'); quality.value=btn.dataset.quality; $('#stickyQuality').textContent=btn.dataset.quality;
      });
      quality.value=available[0];
      $('#stickyQuality').textContent=available[0];
    }

    // Store the backend-resolved public URL so download analysis and UI remain consistent.
    url.value=data.url||raw;
    result.hidden=false;
    result.scrollIntoView({behavior:'smooth',block:'center'});
    return data;
  }catch(err){
    if(panel){
      panel.className='validation-panel error';
      document.getElementById('validationTitle').textContent='Link not supported';
      document.getElementById('validationMessage').textContent=err.message||'Unable to analyze this URL.';
      document.getElementById('validationDetails').innerHTML='';
    }
    result.hidden=true;
    return null;
  }
}

$('#analyzeBtn').onclick=()=>{
  const raw=url.value.trim();
  if(!validDirect(raw)){
    const panel=document.getElementById('linkValidation');
    if(panel){
      panel.hidden=false; panel.className='validation-panel error';
      document.getElementById('validationTitle').textContent='Invalid link';
      document.getElementById('validationMessage').textContent='Paste a complete HTTP or HTTPS media URL.';
      document.getElementById('validationDetails').innerHTML='';
    }
    url.focus(); return;
  }
  analyzeWithBackend(raw);
};

// Source tabs and search helper.
const linkTab = document.querySelector('#linkTab');
const searchTab = document.querySelector('#searchTab');
const linkSource = document.querySelector('#linkSource');
const searchSource = document.querySelector('#searchSource');
const searchResults = document.querySelector('#searchResults');

function setSource(source){
  const isSearch = source === 'search';
  linkTab.classList.toggle('active', !isSearch);
  searchTab.classList.toggle('active', isSearch);
  linkSource.classList.toggle('active', !isSearch);
  searchSource.classList.toggle('active', isSearch);
  if(isSearch) document.querySelector('#searchInput').focus();
  else url.focus();
}
linkTab?.addEventListener('click',()=>setSource('link'));
searchTab?.addEventListener('click',()=>setSource('search'));

function domainFromUrl(raw){
  try{return new URL(raw).hostname.replace(/^www\./,'')}catch{return 'Unknown source'}
}
function resultThumb(item){
  const icon=item?.Icon?.URL || item?.Icon?.URL;
  if(icon) return icon.startsWith('//') ? 'https:'+icon : icon;
  return '';
}
function flattenSearchTopics(topics=[]){
  const out=[];
  for(const topic of topics){
    if(topic?.Topics) out.push(...flattenSearchTopics(topic.Topics));
    else if(topic?.FirstURL) out.push(topic);
  }
  return out;
}
const selectedVideoResults = new Map();

function isLikelyVideoResult(item){
  const href=String(item?.FirstURL||'');
  const text=String(item?.Text||'');
  const hay=`${href} ${text}`.toLowerCase();
  const videoExt=/\.(mp4|webm|mov|m4v|mkv)(?:$|[?#])/i.test(href);
  const videoHost=/(youtube\.com|youtu\.be|vimeo\.com|dailymotion\.com|twitch\.tv|rumble\.com|tiktok\.com|facebook\.com|instagram\.com)/i.test(href);
  const videoWords=/(video|watch|clip|trailer|tutorial|shorts|stream)/i.test(hay);
  return videoExt || videoHost || videoWords;
}
function escapeAttr(value){return escapeHtml(String(value||''));}
function searchCard(item, index){
  const href=item.FirstURL;
  const video=item.video||{};
  const title=video.title||item.Text||href;
  const domain=video.channel||video.platform||domainFromUrl(href);
  const thumb=video.thumbnail||resultThumb(item);
  const selected=selectedVideoResults.has(href);
  const duration=video.duration?formatDuration(video.duration):'';
  const views=video.viewCount?formatCompactNumber(video.viewCount)+' views':'';
  return `<article class="search-result-card ${selected?'is-selected':''}" data-result-url="${escapeAttr(href)}">
    <div class="search-result-thumb" data-preview-url="${escapeAttr(href)}" data-preview-title="${escapeAttr(title)}">${thumb?`<img src="${escapeAttr(thumb)}" alt="" loading="lazy" referrerpolicy="no-referrer">`:''}<span class="thumb-play">▶</span><span class="video-badge">VIDEO</span>${duration?`<span class="duration-badge">${escapeHtml(duration)}</span>`:''}</div>
    <div class="search-result-body">
      <div class="search-result-top"><label class="video-select"><input type="checkbox" data-video-select data-url="${escapeAttr(href)}" ${selected?'checked':''}><span></span></label><span class="search-result-number">${index+1}</span><span class="search-result-domain">${escapeHtml(domain)}</span></div>
      <h3 title="${escapeAttr(title)}">${escapeHtml(title)}</h3>
      <p>${escapeHtml([video.channel,views,video.uploadDate].filter(Boolean).join(' • ')||item.Text||'Video')}</p>
      <div class="search-result-actions"><button class="result-action stream-action" data-result-action="watch" data-url="${escapeAttr(href)}">Watch ▶</button><button class="result-action primary-mini" data-result-action="download" data-url="${escapeAttr(href)}">Download ↓</button><button class="result-action" data-result-action="select" data-url="${escapeAttr(href)}">${selected?'Selected ✓':'Select'}</button><button class="result-action" data-result-action="open" data-url="${escapeAttr(href)}">Open ↗</button></div>
    </div>
  </article>`;
}
function formatDuration(n){n=Number(n)||0;const h=Math.floor(n/3600),m=Math.floor((n%3600)/60),s=Math.floor(n%60);return h?`${h}h ${m}m`:m?`${m}m ${s}s`:`${s}s`}
function formatCompactNumber(n){n=Number(n)||0;return n>=1e9?(n/1e9).toFixed(1)+'B':n>=1e6?(n/1e6).toFixed(1)+'M':n>=1e3?(n/1e3).toFixed(1)+'K':String(n)}

function updateBatchToolbar(){
  const bar=$('#batchToolbar'); if(!bar)return;
  const count=selectedVideoResults.size;
  bar.hidden=count===0;
  $('#selectedCount').textContent=`${count} selected`;
}
function renderSearchResults(items, query){
  if(!searchResults)return;
  const videoItems=items.filter(isLikelyVideoResult).slice(0,12);
  if(!videoItems.length){
    searchResults.hidden=false;
    searchResults.innerHTML=`<div class="search-empty"><strong>No video results found.</strong><span>Try a broader video search or paste a direct video URL.</span></div>`;
    updateBatchToolbar();
    return;
  }
  searchResults.hidden=false;
  const mainItems=videoItems.slice(0,8);
  const suggested=videoItems.slice(8,12);
  const suggestionMarkup=suggested.length
    ? `<div class="suggested-videos"><div class="suggested-videos-head"><div><span>SUGGESTED VIDEOS</span><strong>More videos you may like</strong></div><small>${suggested.length} more results</small></div>${suggested.map(searchCard).join('')}</div>`
    : '';
  searchResults.innerHTML=`<div class="search-results-head"><div><span>VIDEO RESULTS</span><h3>Videos for “${escapeHtml(query)}”</h3></div><small>${videoItems.length} video candidates • select multiple for batch download</small></div>${mainItems.map(searchCard).join('')}${suggestionMarkup}`;
  updateBatchToolbar();
}
async function fetchSearchPreview(q){
  if(searchResults){
    searchResults.hidden=false;
    searchResults.innerHTML='<div class="search-loading"><span class="search-spinner"></span><strong>Finding videos…</strong><small>Searching the video catalog.</small></div>';
  }
  try{
    const response=await fetch(`/api/search?q=${encodeURIComponent(q)}&limit=16`,{headers:{Accept:'application/json'}});
    const data=await response.json();
    if(!response.ok) throw new Error(data.error||'Search failed');
    const items=(data.videos||[]).map(v=>({
      FirstURL:v.url, Text:v.title, Icon:v.thumbnail?{URL:v.thumbnail}:null,
      video:v
    }));
    renderSearchResults(items,q);
  }catch(err){
    if(searchResults){
      searchResults.hidden=false;
      searchResults.innerHTML=`<div class="search-empty"><strong>Video search is unavailable right now.</strong><span>${escapeHtml(err.message||'Try again or paste a direct video URL.')}</span></div>`;
    }
  }
}

document.querySelectorAll('[data-suggestion]').forEach(btn=>{
  btn.addEventListener('click',()=>{
    const input=$('#searchInput');
    input.value=btn.dataset.suggestion;
    input.focus();
    $('#searchBtn').click();
  });
});
document.querySelector('#searchBtn')?.addEventListener('click',async()=>{
  const q=document.querySelector('#searchInput').value.trim();
  if(!q){document.querySelector('#searchInput').focus();return}
  await fetchSearchPreview(q);
});
document.querySelector('#searchInput')?.addEventListener('keydown',e=>{if(e.key==='Enter')document.querySelector('#searchBtn').click()});

function toggleVideoSelection(href, checked){
  if(checked) selectedVideoResults.set(href,{url:href,title:document.querySelector(`[data-result-url="${CSS.escape(href)}"] h3`)?.textContent||'Selected video'});
  else selectedVideoResults.delete(href);
  const card=document.querySelector(`[data-result-url="${CSS.escape(href)}"]`);
  if(card) card.classList.toggle('is-selected',checked);
  const btn=card?.querySelector('[data-result-action="select"]');
  if(btn) btn.textContent=checked?'Selected ✓':'Select';
  updateBatchToolbar();
}
searchResults?.addEventListener('change',e=>{
  const input=e.target.closest('[data-video-select]');
  if(!input)return;
  toggleVideoSelection(input.dataset.url,input.checked);
});

const playerModal = document.getElementById('playerModal');
const streamPlayer = document.getElementById('streamPlayer');
const playerTitle = document.getElementById('playerTitle');
const playerQuality = document.getElementById('playerQuality');
function closePlayer(){ if(!playerModal)return; streamPlayer.pause(); streamPlayer.removeAttribute('src'); streamPlayer.load(); playerModal.hidden=true; playerModal.setAttribute('aria-hidden','true'); }
async function openPlayer(href,title='Video',quality='best'){
  if(!playerModal || !streamPlayer) return;
  playerTitle.textContent=title;
  playerQuality.textContent='Preparing stream…';
  playerModal.hidden=false; playerModal.setAttribute('aria-hidden','false');
  streamPlayer.src=`/api/stream?url=${encodeURIComponent(href)}&quality=${encodeURIComponent(quality)}`;
  streamPlayer.load();
  try { await streamPlayer.play(); } catch (_) {}
  playerQuality.textContent=quality==='best'?'Auto quality':quality;
}
document.querySelectorAll('[data-close-player]').forEach(el=>el.addEventListener('click',closePlayer));
document.addEventListener('keydown',e=>{if(e.key==='Escape')closePlayer();});

let qualityChooserUrl='';
let qualityChooserTitle='Video';
let qualityChooserData=null;
async function openQualityChooser(href,title='Video'){
  qualityChooserUrl=href; qualityChooserTitle=title; qualityChooserData=null;
  const modal=$('#qualityChooserModal'); const grid=$('#qualityChooserGrid');
  if(!modal||!grid)return;
  modal.hidden=false; $('#qualityChooserTitle').textContent=title; $('#qualityChooserStatus').textContent='Checking available qualities…';
  grid.innerHTML='<div class="quality-loading">Loading available qualities…</div>';
  try{
    const r=await fetch('/api/analyze',{method:'POST',headers:{'Content-Type':'application/json','Accept':'application/json'},body:JSON.stringify({url:href})});
    const d=await r.json(); if(!r.ok||!d.supported)throw new Error(d.error||'Unable to read video qualities.');
    qualityChooserData=d; const qs=d.qualities?.length?d.qualities:['Best available'];
    $('#qualityChooserStatus').textContent=`${d.provider||'Source'} • ${qs.length} quality option${qs.length===1?'':'s'}`;
    grid.innerHTML=qs.map((q,i)=>`<button type="button" class="quality-choice ${i===0?'active':''}" data-choice-quality="${escapeAttr(q)}"><strong>${escapeHtml(q)}</strong><span>${i===0?'Recommended':'Available from source'}</span></button>`).join('');
  }catch(err){$('#qualityChooserStatus').textContent=err.message||'Could not load qualities.';grid.innerHTML='<div class="quality-loading">Try opening the video first or use another source.</div>';}
}
function closeQualityChooser(){const m=$('#qualityChooserModal');if(m)m.hidden=true;qualityChooserUrl='';qualityChooserData=null;}
$('#qualityChooserGrid')?.addEventListener('click',e=>{const b=e.target.closest('[data-choice-quality]');if(!b)return;document.querySelectorAll('.quality-choice').forEach(x=>x.classList.remove('active'));b.classList.add('active');});
$('#qualityChooserCancel')?.addEventListener('click',closeQualityChooser);
$('#qualityChooserModal')?.addEventListener('click',e=>{if(e.target.matches('[data-close-quality]'))closeQualityChooser();});
$('#qualityChooserDownload')?.addEventListener('click',async()=>{
  const choice=document.querySelector('.quality-choice.active'); if(!choice||!qualityChooserUrl)return;
  const quality=choice.dataset.choiceQuality; const d=qualityChooserData||{}; const chosenUrl=qualityChooserUrl; const chosenTitle=qualityChooserTitle; closeQualityChooser();
  const card={id:Date.now().toString(36)+Math.random().toString(36).slice(2,7),name:chosenTitle,format:'MP4',quality,url:chosenUrl,progress:0,state:'starting',bytes:0,totalBytes:null,speed:'Starting…',eta:'Calculating…',saved:false,saving:false,saveMessage:'',fileName:''};
  activeDownloads.set(card.id,card); renderDownloads(); document.querySelector('#downloads')?.scrollIntoView({behavior:'smooth',block:'center'});
  try{await startRealDownload(card.url,quality,'mp4',card);refreshUserQuota()}catch(err){card.state='error';card.error=friendlyDownloadError(err,null);card.speed='—';card.eta='—';renderDownloads();}
});

searchResults?.addEventListener('click',async e=>{
  const btn=e.target.closest('[data-result-action]');
  if(!btn)return;
  const href=btn.dataset.url;
  if(!validDirect(href))return;
  const action=btn.dataset.resultAction;
  if(action==='open'){window.open(href,'_blank','noopener,noreferrer');return}
  if(action==='watch'){ window.location.href=`/watch?url=${encodeURIComponent(href)}`; return; }
  if(action==='stream'){ openPlayer(href, btn.closest('.search-result-card')?.querySelector('h3')?.textContent || 'Video'); return; }
  if(action==='download' || action==='use'){ openQualityChooser(href, btn.closest('.search-result-card')?.querySelector('h3')?.textContent || 'Video'); return; }
  if(action==='select'){
    const next=!selectedVideoResults.has(href);
    const checkbox=document.querySelector(`[data-video-select][data-url="${CSS.escape(href)}"]`);
    if(checkbox) checkbox.checked=next;
    toggleVideoSelection(href,next);
  }
});
$('#selectAllVideos')?.addEventListener('click',()=>{
  document.querySelectorAll('[data-video-select]').forEach(input=>{
    input.checked=true;
    selectedVideoResults.set(input.dataset.url,{url:input.dataset.url,title:input.closest('.search-result-card')?.querySelector('h3')?.textContent||'Selected video'});
  });
  renderSearchResults([...document.querySelectorAll('.search-result-card')].map((card,i)=>({
    FirstURL:card.dataset.resultUrl,Text:card.querySelector('h3')?.textContent||'',Icon:null
  })),$('#searchInput').value.trim());
});
$('#clearSelectedVideos')?.addEventListener('click',()=>{
  selectedVideoResults.clear();
  updateBatchToolbar();
  document.querySelectorAll('[data-video-select]').forEach(input=>input.checked=false);
  document.querySelectorAll('.search-result-card').forEach(card=>card.classList.remove('is-selected'));
  document.querySelectorAll('[data-result-action="select"]').forEach(btn=>btn.textContent='Select');
});

const activeDownloads = new Map();
function formatSpeed(mbps){
  if(!Number.isFinite(mbps) || mbps<=0) return '—';
  return mbps>=1 ? `${mbps.toFixed(1)} MB/s` : `${Math.max(mbps*1024,1).toFixed(0)} KB/s`;
}
function formatEta(seconds){
  if(!Number.isFinite(seconds) || seconds<0) return '—';
  const s=Math.ceil(seconds);
  if(s<60) return `${s}s remaining`;
  const m=Math.floor(s/60), sec=s%60;
  if(m<60) return `${m}m ${sec}s remaining`;
  const h=Math.floor(m/60), min=m%60;
  return `${h}h ${min}m remaining`;
}
function formatBytes(bytes){
  if(!Number.isFinite(bytes) || bytes<=0) return '—';
  const units=['B','KB','MB','GB','TB'];
  const i=Math.min(Math.floor(Math.log(bytes)/Math.log(1024)),units.length-1);
  return `${(bytes/Math.pow(1024,i)).toFixed(i ? 1 : 0)} ${units[i]}`;
}
function addHistory(urlValue, formatValue, qualityValue, name='Your media'){
  const h=JSON.parse(localStorage.getItem('streamdrop-history')||'[]');
  h.unshift({name,type:String(formatValue).toUpperCase(),quality:qualityValue,url:urlValue,date:new Date().toISOString()});
  localStorage.setItem('streamdrop-history',JSON.stringify(h.slice(0,20)));
  loadHistory();
}
const autoBrowserSaves = new Set();

function saveCompletedToBrowser(d, automatic=false){
  if(!d?.jobId || d.state!=='complete' || d.saving) return;
  if(automatic && autoBrowserSaves.has(d.jobId)) return;
  if(automatic) autoBrowserSaves.add(d.jobId);
  d.saving=true;
  d.saveMessage='Opening browser save…';
  renderDownloads();
  const a=document.createElement('a');
  a.href=`/api/download/${encodeURIComponent(d.jobId)}/file`;
  a.download=d.fileName||'';
  a.rel='noopener';
  a.style.display='none';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(()=>{
    d.saving=false;
    d.saved=true;
    d.saveMessage='Sent to your browser downloads';
    renderDownloads();
  },300);
}
let downloadManagerFilter='all';
function renderDownloads(){
  const panel=$('#downloadPanel');
  const all=[...activeDownloads.values()];
  const visible=all.filter(d=>downloadManagerFilter==='all'?true:downloadManagerFilter==='downloading'?['queued','starting','downloading'].includes(d.state):d.state===downloadManagerFilter);
  const active=all.filter(d=>['queued','starting','downloading'].includes(d.state)).length; const completed=all.filter(d=>d.state==='complete').length; const failed=all.filter(d=>d.state==='error').length;
  const badge=$('#mobileDownloadBadge'); if(badge){badge.hidden=active===0;badge.textContent=String(active)}
  const count=$('#managerCount'),summary=$('#managerSummary'); if(count)count.textContent=`${all.length} item${all.length===1?'':'s'}`; if(summary)summary.textContent=`${active} active • ${completed} completed${failed?` • ${failed} failed`:''}`;
  if(!all.length){panel.innerHTML='<div class="download-empty">Nothing is in your queue yet. Start a download to see live progress here.</div>';return;}
  if(!visible.length){panel.innerHTML='<div class="download-empty">No downloads match this filter.</div>';return;}
  panel.innerHTML=visible.map(d=>{
    const statusLabel=d.state==='queued'?'QUEUED':d.state==='downloading'?'DOWNLOADING':d.state==='complete'?'READY TO SAVE':d.state==='error'?'FAILED':'CANCELED';
    const percent=d.state==='complete'?100:Math.max(0,Math.min(100,Number(d.progress)||0));
    const size=d.totalBytes ? `${formatBytes(d.bytes||0)} / ${formatBytes(d.totalBytes)}` : (d.bytes ? formatBytes(d.bytes) : 'Preparing…');
    const message=d.state==='complete'
      ? (d.saving ? 'Saving to your browser…' : (d.saved ? 'Sent to your browser downloads' : 'Download is ready — tap Save to browser'))
      : d.state==='error'
        ? (d.error||'The download failed. Please try again.')
        : d.state==='canceled'
          ? 'Download canceled'
          : d.state==='queued'
            ? 'Waiting for an available download slot'
            : `${size} downloaded`;
    return `<div class="download-card-item ${d.state}" data-id="${escapeHtml(d.id)}">
      <div class="download-card-top">
        <div class="download-card-title"><strong>${escapeHtml(d.name)}</strong><small>${escapeHtml(d.format)} • ${escapeHtml(d.quality)}</small></div>
        <span class="download-status ${d.state}">${statusLabel}</span>
      </div>
      <div class="progress-track" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${percent}"><div class="progress-fill ${d.state}" style="width:${percent}%"></div></div>
      <div class="download-metrics">
        <span><b>Progress</b> ${percent.toFixed(0)}%</span>
        <span><b>Speed</b> ${d.state==='complete'?'Ready':d.speed||'—'}</span>
        <span><b>ETA</b> ${d.state==='complete'?'Done':d.state==='downloading'?(d.eta||'Calculating…'):'—'}</span>
      </div>
      <div class="download-actions">
        <span class="progress-percent">${escapeHtml(message)}</span>
        <div class="progress-buttons">
          ${d.state==='downloading'?'<button class="progress-btn cancel" data-action="cancel">Cancel</button>':''}
          ${d.state==='error' || d.state==='canceled'?'<button class="progress-btn retry" data-action="retry">Retry</button>':''}
          ${d.state==='complete' && !d.saving?`<button class="progress-btn save-browser" data-action="save">${d.saved?'Save to browser again ↓':'Save to browser ↓'}</button>`:''}
          ${d.state==='complete' && d.saved?'<button class="progress-btn" data-action="dismiss">Clear</button>':''}
        </div>
      </div>
    </div>`;
  }).join('');
}
function makeDownloadCard(){
  return {id:Date.now().toString(36)+Math.random().toString(36).slice(2,7),name:$('#videoTitle').textContent||'Your media',format:$('#format').value.toUpperCase(),quality:$('#quality').value,url:url.value.trim(),progress:0,state:'starting',bytes:0,totalBytes:null,speed:'Starting…',eta:'Calculating…',saved:false,saving:false,saveMessage:'',fileName:''};
}
async function startRealDownload(urlValue, qualityValue, formatValue, card){
  const start=await fetch('/api/download/start',{
    method:'POST',
    headers:{'Content-Type':'application/json','Accept':'application/json'},
    credentials:'include',
    body:JSON.stringify({url:urlValue,quality:qualityValue,format:formatValue})
  });
  let started={};
  try{started=await start.json()}catch(_){started={}}
  if(!start.ok){
    const err=new Error(started.error||'Could not start download.');
    err.code=started.code||''; err.retryAfter=started.retryAfter||start.headers.get('Retry-After')||'';
    throw err;
  }
  const jobId=started.jobId;
  if(!jobId) throw new Error('The download service did not return a job ID.');
  card.jobId=jobId;
  card.state='downloading';
  card.progress=0;
  card.speed='Starting…';
  card.eta='Calculating…';
  renderDownloads();

  const poll=async()=>{
    const res=await fetch(`/api/download/${encodeURIComponent(jobId)}/status`,{cache:'no-store',credentials:'include'});
    let data={};
    try{data=await res.json()}catch(_){data={}}
    if(!res.ok) throw new Error(data.error||'Download status unavailable.');
    card.bytes=Number(data.bytes)||0;
    card.totalBytes=Number(data.totalBytes)||null;
    card.progress=card.totalBytes ? Math.min(100,(card.bytes/card.totalBytes)*100) : (data.status==='complete'?100:0);
    card.speed=formatSpeed((Number(data.speedBytesPerSecond)||0)/1048576);
    card.eta=data.status==='complete'?'Complete':formatEta(Number(data.etaSeconds));
    card.state=data.status==='complete'?'complete':data.status==='error'?'error':data.status==='canceled'?'canceled':'downloading';
    card.error=data.error||'';
    card.fileName=data.fileName||data.filename||card.fileName||'';
    renderDownloads();

    if(card.state==='complete'){
      card.progress=100;
      card.eta='Complete';
      card.saveMessage='Saving to your browser…';
      addHistory(urlValue,formatValue,qualityValue,card.name);
      renderDownloads();
      // Automatically hand the completed streamed file to the browser.
      // The card remains COMPLETE so the user can see the final status.
      saveCompletedToBrowser(card, true);
      return;
    }
    if(card.state==='error' || card.state==='canceled') return;
    setTimeout(poll,350);
  };
  await poll();
}
async function startBatchDownload(){
  const items=[...selectedVideoResults.values()];
  if(!items.length){alert('Select at least one video first.');return}
  const fmt=$('#format').value, quality=$('#quality').value;
  document.querySelector('#downloads').scrollIntoView({behavior:'smooth',block:'center'});
  const queue=items.map(item=>{
    const card={id:Date.now().toString(36)+Math.random().toString(36).slice(2,7),name:item.title||'Selected video',format:fmt.toUpperCase(),quality,url:item.url,progress:0,state:'queued',bytes:0,totalBytes:null,speed:'Waiting…',eta:'Queued',saved:false,saving:false,saveMessage:'',fileName:''};
    activeDownloads.set(card.id,card); return card;
  });
  selectedVideoResults.clear(); updateBatchToolbar(); renderDownloads();
  let cursor=0;
  const worker=async()=>{while(cursor<queue.length){const card=queue[cursor++];card.state='starting';card.speed='Starting…';card.eta='Calculating…';renderDownloads();try{await startRealDownload(card.url,quality,fmt,card)}catch(err){card.state='error';card.error=friendlyDownloadError(err,null);card.speed='—';card.eta='—';renderDownloads()}}};
  await Promise.all(Array.from({length:Math.min(3,queue.length)},worker)); refreshUserQuota();
}
$('#batchDownloadBtn')?.addEventListener('click',startBatchDownload);

async function startDownload(){
  const u=url.value.trim(), fmt=$('#format').value, quality=$('#quality').value;
  if(!validDirect(u)){alert('Paste a valid video or media link first.');setSource('link');url.focus();return}
  const card=makeDownloadCard();
  activeDownloads.set(card.id,card);
  renderDownloads();
  document.querySelector('#downloads').scrollIntoView({behavior:'smooth',block:'center'});
  try{
    await startRealDownload(u,quality,fmt,card);
    refreshUserQuota();
  }catch(err){
    card.state='error';
    card.error=friendlyDownloadError(err,null);
    card.speed='—'; card.eta='—';
    renderDownloads();
    refreshUserQuota();
  }
}
$('#downloadBtn').onclick=startDownload;
$('#downloadPanel').onclick=async(e)=>{
  const btn=e.target.closest('[data-action]'); if(!btn)return;
  const cardEl=e.target.closest('.download-card-item'); const id=cardEl?.dataset.id; const d=activeDownloads.get(id); if(!d)return;
  const action=btn.dataset.action;
  if(action==='save'){saveCompletedToBrowser(d);return}
  if(action==='dismiss'){activeDownloads.delete(id);renderDownloads();return}
  if(action==='cancel'){
    if(d.jobId){
      try{await fetch(`/api/download/${encodeURIComponent(d.jobId)}/cancel`,{method:'POST',credentials:'include'})}catch(_){ }
    }
    d.state='canceled';d.speed='—';d.eta='—';renderDownloads();return;
  }
  if(action==='retry'){
    d.state='starting';d.progress=0;d.bytes=0;d.totalBytes=null;d.saved=false;d.error='';renderDownloads();
    try{await startRealDownload(d.url,d.quality,d.format.toLowerCase(),d);refreshUserQuota()}
    catch(err){d.state='error';d.error=friendlyDownloadError(err,null);renderDownloads();refreshUserQuota()}
  }
};

document.querySelectorAll('[data-manager-filter]').forEach(btn=>btn.addEventListener('click',()=>{downloadManagerFilter=btn.dataset.managerFilter;document.querySelectorAll('[data-manager-filter]').forEach(x=>x.classList.toggle('active',x===btn));renderDownloads()}));
$('#clearCompletedBtn')?.addEventListener('click',()=>{for(const [id,d] of activeDownloads){if(['complete','canceled','error'].includes(d.state))activeDownloads.delete(id)}renderDownloads()});
$('#cancelAllBtn')?.addEventListener('click',async()=>{const active=[...activeDownloads.values()].filter(d=>['queued','starting','downloading'].includes(d.state));for(const d of active){if(d.jobId){try{await fetch(`/api/download/${encodeURIComponent(d.jobId)}/cancel`,{method:'POST',credentials:'include'})}catch(_){}}d.state='canceled';d.speed='—';d.eta='—'}renderDownloads()});
$('#clearBtn').onclick=()=>{localStorage.removeItem('streamdrop-history');loadHistory()};
$('#themeBtn').onclick=()=>{document.body.classList.toggle('dark');localStorage.setItem('streamdrop-dark',document.body.classList.contains('dark'))};
if(localStorage.getItem('streamdrop-dark')==='true')document.body.classList.add('dark');
loadHistory();

const stickyBtn = document.querySelector('#stickyDownloadBtn');
const stickyQuality = document.querySelector('#stickyQuality');
const stickyFormat = document.querySelector('#stickyFormat');
const qualityNative = document.querySelector('#quality');

document.querySelectorAll('.quality-chip').forEach(btn=>{
  btn.addEventListener('click',()=>{
    document.querySelectorAll('.quality-chip').forEach(x=>x.classList.remove('active'));
    btn.classList.add('active');
    qualityNative.value = btn.dataset.quality;
    stickyQuality.textContent = btn.dataset.quality;
  });
});
document.querySelector('#format').addEventListener('change', e=>{
  const text = e.target.options[e.target.selectedIndex].text;
  stickyFormat.textContent = text;
});
stickyBtn?.addEventListener('click',()=>document.querySelector('#downloadBtn').click());

/* First-use walkthrough */
(() => {
  const overlay = document.getElementById('streamdropWalkthrough');
  if (!overlay) return;

  const title = document.getElementById('walkthroughTitle');
  const text = document.getElementById('walkthroughText');
  const step = document.getElementById('walkthroughStep');
  const icon = document.getElementById('walkthroughIcon');
  const next = document.getElementById('walkthroughNext');
  const dots = [...overlay.querySelectorAll('.walkthrough-dots span')];

  const steps = [
    { icon: '🔗', title: 'Find or paste a video', text: 'Search for videos or paste a direct video link you’re authorized to download.' },
    { icon: '⚙️', title: 'Choose your quality', text: 'Select one or more videos, then choose the quality and video format.' },
    { icon: '⬇️', title: 'Start your download', text: 'Tap Download and watch the queue, speed, progress, and estimated time remaining.' }
  ];
  let index = 0;
  let touchStartX = 0;
  let touchStartY = 0;
  let touchMoved = false;

  function close() {
    overlay.classList.remove('is-open');
    overlay.setAttribute('aria-hidden', 'true');
    localStorage.setItem('streamdrop-walkthrough-seen', '1');
  }

  function render() {
    const s = steps[index];
    icon.textContent = s.icon;
    title.textContent = s.title;
    text.textContent = s.text;
    step.textContent = `Step ${index + 1} of ${steps.length}`;
    dots.forEach((dot, i) => dot.classList.toggle('active', i === index));
    next.textContent = index === steps.length - 1 ? 'Get started' : 'Next';
  }

  function goNext() {
    if (index === steps.length - 1) close();
    else { index += 1; render(); }
  }

  function goPrevious() {
    if (index > 0) { index -= 1; render(); }
  }

  next.addEventListener('click', goNext);

  const card = overlay.querySelector('.walkthrough-card');
  card.addEventListener('touchstart', (e) => {
    if (!e.touches.length) return;
    touchStartX = e.touches[0].clientX;
    touchStartY = e.touches[0].clientY;
    touchMoved = false;
  }, { passive: true });

  card.addEventListener('touchmove', (e) => {
    if (!e.touches.length) return;
    const dx = e.touches[0].clientX - touchStartX;
    const dy = e.touches[0].clientY - touchStartY;
    if (Math.abs(dx) > 12 && Math.abs(dx) > Math.abs(dy)) touchMoved = true;
  }, { passive: true });

  card.addEventListener('touchend', (e) => {
    if (!touchMoved || !e.changedTouches.length) return;
    const dx = e.changedTouches[0].clientX - touchStartX;
    if (Math.abs(dx) < 55) return;
    if (dx < 0) goNext();
    else goPrevious();
    touchMoved = false;
  }, { passive: true });

  overlay.querySelectorAll('[data-walkthrough-skip]').forEach(el => el.addEventListener('click', close));
  document.addEventListener('keydown', e => {
    if (!overlay.classList.contains('is-open')) return;
    if (e.key === 'Escape') close();
    if (e.key === 'ArrowRight') goNext();
    if (e.key === 'ArrowLeft') goPrevious();
  });

  if (!localStorage.getItem('streamdrop-walkthrough-seen')) {
    render();
    requestAnimationFrame(() => {
      overlay.classList.add('is-open');
      overlay.setAttribute('aria-hidden', 'false');
    });
  }
})();


/* Link validation and lightweight direct-media detection.
   This detects formats from the URL and uses a HEAD request when the source
   permits CORS. It never bypasses authentication, DRM, or private access. */
function formatBytes(bytes){
  if (!Number.isFinite(bytes) || bytes <= 0) return 'Unknown';
  const units = ['B','KB','MB','GB','TB'];
  const i = Math.min(Math.floor(Math.log(bytes)/Math.log(1024)), units.length-1);
  return `${(bytes/Math.pow(1024,i)).toFixed(i ? 1 : 0)} ${units[i]}`;
}

function getUrlMediaInfo(raw){
  try{
    const u = new URL(raw);
    const path = decodeURIComponent(u.pathname).toLowerCase();
    const extMatch = path.match(/\.([a-z0-9]{2,5})$/);
    const ext = extMatch ? extMatch[1] : '';
    const map = {
      mp4:{type:'Video', format:'MP4'}, webm:{type:'Video',format:'WebM'},
      mov:{type:'Video',format:'MOV'}, m4v:{type:'Video',format:'M4V'},
      mkv:{type:'Video',format:'MKV'}, avi:{type:'Video',format:'AVI'},
      mp3:{type:'Audio',format:'MP3'}, m4a:{type:'Audio',format:'M4A'},
      wav:{type:'Audio',format:'WAV'}, ogg:{type:'Audio',format:'OGG'},
      flac:{type:'Audio',format:'FLAC'}, aac:{type:'Audio',format:'AAC'}
    };
    return {url:u, ext, ...(map[ext] || {type:'Media link',format:'Detecting'})};
  }catch(e){ return null; }
}

function setValidation(kind,title,message,details=[]){
  const panel=document.getElementById('linkValidation');
  if(!panel) return;
  panel.hidden=false;
  panel.className=`validation-panel ${kind}`;
  document.getElementById('validationTitle').textContent=title;
  document.getElementById('validationMessage').textContent=message;
  document.getElementById('validationDetails').innerHTML=details.map(x=>`<span class="validation-chip">${x}</span>`).join('');
}

async function validateAndDetectLink(raw){
  const info=getUrlMediaInfo(raw);
  const meta=document.getElementById('mediaMeta');
  if(meta) meta.hidden=true;

  if(!info || !/^https?:$/.test(info.url.protocol)){
    setValidation('error','Unsupported link','Use a complete HTTP or HTTPS media URL.');
    return {supported:false};
  }

  setValidation('checking','Checking link…','Validating the URL and looking for media details.');

  let contentType='', size=NaN, headOk=false;
  try{
    const res=await fetch(info.url.href,{method:'HEAD',cache:'no-store'});
    headOk=res.ok;
    contentType=(res.headers.get('content-type')||'').toLowerCase();
    size=Number(res.headers.get('content-length'));
  }catch(e){}

  const isMedia=/^(video|audio)\//.test(contentType) || ['mp4','webm','mov','m4v','mkv','avi','mp3','m4a','wav','ogg','flac','aac'].includes(info.ext);
  const formats=info.ext ? [info.format] : (contentType.includes('webm')?['WebM']:contentType.includes('mp4')?['MP4']:contentType.includes('mpeg')?['MP3']:['Direct media']);

  const details=[
    `${info.type}`,
    `Format: ${formats.join(', ')}`,
    `Size: ${formatBytes(size)}`
  ];

  if(!isMedia && headOk){
    setValidation('error','Link found, but media was not detected','This URL appears to point to a webpage or unsupported resource. Use a direct media URL.');
    return {supported:false};
  }

  setValidation('success','Link supported','Media detected. Review the available details before downloading.',details);

  if(meta){
    meta.hidden=false;
    document.getElementById('detectedType').textContent=info.type;
    document.getElementById('detectedSize').textContent=formatBytes(size);
    document.getElementById('detectedFormats').textContent=formats.join(', ');
  }

  // Update the quality selector: direct URLs expose the source quality only;
  // do not invent qualities that the source has not advertised.
  const quality=document.getElementById('quality');
  if(quality){
    [...quality.options].forEach(o=>{
      if(/original/i.test(o.text)) o.text=`Original${Number.isFinite(size)?` • ${formatBytes(size)}`:''}`;
    });
  }

  return {supported:true,info,size,contentType,formats};
}

document.addEventListener('DOMContentLoaded', () => {
  const analyzeButton = document.getElementById('analyze') || document.getElementById('analyzeBtn');
  const input = document.getElementById('url');
  if (analyzeButton && input) {
    analyzeButton.addEventListener('click', () => validateAndDetectLink(input.value.trim()));
  }
});


/* Real backend download flow */
function formatSpeed(bytesPerSecond){
  if(!Number.isFinite(bytesPerSecond) || bytesPerSecond <= 0) return '—';
  const units=['B/s','KB/s','MB/s','GB/s'];
  let n=bytesPerSecond, i=0;
  while(n>=1024 && i<units.length-1){n/=1024;i++;}
  return `${n.toFixed(i?1:0)} ${units[i]}`;
}
function formatEta(seconds){
  if(!Number.isFinite(seconds) || seconds < 0) return 'Calculating…';
  const s=Math.ceil(seconds);
  if(s<60) return `${s}s remaining`;
  const m=Math.floor(s/60), r=s%60;
  return r ? `${m}m ${r}s remaining` : `${m}m remaining`;
}

function readQuotaHeaders(response) {
  const remaining = response?.headers?.get("X-Veyra-Quota-Remaining");
  const limit = response?.headers?.get("X-Veyra-Quota-Limit");
  const reset = response?.headers?.get("X-Veyra-Quota-Reset");
  return {
    remaining: remaining == null ? null : Number(remaining),
    limit: limit == null ? null : Number(limit),
    reset: reset == null ? null : Number(reset)
  };
}

function renderUserQuota(quota) {
  const el = document.querySelector("[data-user-quota]");
  if (!el) return;
  if (!quota || quota.authenticated === false || !quota.userQuota) {
    el.textContent = "Sign in to see your remaining download quota.";
    el.hidden = false;
    return;
  }
  const q = quota.userQuota;
  el.textContent = `${q.remaining} of ${q.limit} downloads remaining`;
  el.hidden = false;
}

async function refreshUserQuota() {
  try {
    const response = await fetch("/api/quota", { credentials: "include" });
    if (response.ok) renderUserQuota(await response.json());
  } catch (_) {
    // Quota display is informational; do not block downloads if it is unavailable.
  }
}

function friendlyDownloadError(error, response) {
  const status = response?.status;
  const code = error?.code || "";
  if (status === 429 || code.includes("QUOTA") || code.includes("RATE_LIMIT") || code.includes("CONCURRENCY")) {
    const retry = Number(error?.retryAfter || response?.headers?.get?.("Retry-After") || 0);
    return retry > 0
      ? `Veyra is limiting requests right now. Please wait about ${retry} seconds and try again.`
      : "Veyra is limiting requests right now. Please wait a moment and try again.";
  }
  if (status === 413 || code === "REQUEST_TOO_LARGE") {
    return "This request is too large. Please send a smaller request.";
  }
  if (status === 400) return error?.error || "The download request was rejected. Check the link and try again.";
  if (status === 403) return "This download request is not allowed.";
  if (status >= 500) return "The download service is temporarily unavailable. Please try again.";
  return error?.error || "The download could not be started.";
}


document.addEventListener("DOMContentLoaded", () => {
  refreshUserQuota();
});

// Discovery category layer. These are intentionally generic starter suggestions;
// live platform results can replace them when the backend/search provider is available.
const discoveryCatalog = {
  home: {label:'POPULAR NOW', title:'Popular videos', note:'Suggested videos to get you started', queries:['trending video','popular videos','viral videos','best videos']},
  shorts: {label:'SHORTS', title:'Shorts', note:'Quick videos and vertical clips', queries:['YouTube Shorts','shorts videos','viral shorts','funny shorts']},
  new: {label:'JUST IN', title:'New videos', note:'Fresh searches to discover', queries:['new videos','latest videos','new uploads','today videos']},
  popular: {label:'TRENDING', title:'Popular', note:'What people are watching', queries:['trending videos','most popular videos','viral videos','trending now']},
  music: {label:'MUSIC', title:'Music', note:'Music videos and performances', queries:['music videos','new music videos','live music','music performance']},
  gaming: {label:'GAMING', title:'Gaming', note:'Gameplay, highlights and creators', queries:['gaming videos','gaming highlights','gameplay','gaming news']},
  sports: {label:'SPORTS', title:'Sports', note:'Highlights, analysis and action', queries:['sports highlights','football highlights','basketball highlights','sports news']},
  movies: {label:'MOVIES & TV', title:'Movies & TV', note:'Trailers, clips and entertainment', queries:['movie trailers','TV trailers','movie clips','entertainment videos']},
  news: {label:'NEWS', title:'News', note:'Current events and video reports', queries:['news videos','latest news video','world news video','technology news video']}
};
const discoverGrid=document.getElementById('discoverGrid');
const discoverEyebrow=document.getElementById('discoverEyebrow');
const discoverTitle=document.getElementById('discoverTitle');
const discoverNote=document.getElementById('discoverNote');
let activeDiscovery='home';
function discoveryFallback(category){
  const cfg=discoveryCatalog[category];
  return cfg.queries.map((q,i)=>({url:'',title:q.charAt(0).toUpperCase()+q.slice(1),meta:'Search to find current videos',query:q,index:i}));
}
function renderDiscovery(items, category){
  if(!discoverGrid)return;
  const cfg=discoveryCatalog[category]||discoveryCatalog.home;
  discoverEyebrow.textContent=cfg.label; discoverTitle.textContent=cfg.title; discoverNote.textContent=cfg.note;
  const list=items.length?items.slice(0,8):discoveryFallback(category);
  discoverGrid.innerHTML=list.map((item,i)=>{
    const href=item.url||item.FirstURL||'';
    const title=item.title||item.Text||cfg.queries[i%cfg.queries.length];
    const thumb=item.thumbnail||item.Icon?.URL||'';
    return `<article class="discover-card">\n      <div class="discover-thumb" ${href?`data-discover-stream="${escapeAttr(href)}"`:''}>${thumb?`<img src="${escapeAttr(thumb)}" alt="" loading="lazy" referrerpolicy="no-referrer">`:'<span></span>'}<span class="discover-play">▶</span><span class="discover-badge">VIDEO</span></div>\n      <h4>${escapeHtml(title)}</h4><p>${escapeHtml(item.meta||item.domain||'Video suggestion')}</p>\n      <div class="discover-actions">${href?`<button type="button" data-discover-watch="${escapeAttr(href)}">Watch</button><button type="button" class="download-discover" data-discover-download="${escapeAttr(href)}">Download ↓</button>`:`<button type="button" data-discover-search="${escapeAttr(item.query||title)}">Find videos</button>`}</div>\n    </article>`;
  }).join('');
}
async function loadDiscovery(category='home', customQuery=''){
  activeDiscovery=category;
  document.querySelectorAll('.category-tab').forEach(b=>b.classList.toggle('active',b.dataset.category===category));
  const cfg=discoveryCatalog[category]||discoveryCatalog.home;
  discoverEyebrow.textContent=cfg.label; discoverTitle.textContent=cfg.title; discoverNote.textContent='Loading live suggestions…';
  discoverGrid.innerHTML='<div class="discover-loading">Finding current videos…</div>';
  try{
    const q=customQuery||cfg.queries[0];
    const response=await fetch(`/api/discover?category=${encodeURIComponent(category)}&q=${encodeURIComponent(q)}&limit=16`,{headers:{Accept:'application/json'}});
    const data=await response.json();
    if(!response.ok) throw new Error(data.error||'Discovery failed');
    const items=(data.videos||[]).map(v=>({url:v.url,title:v.title,thumbnail:v.thumbnail,domain:v.platform,meta:[v.channel, v.viewCount!=null?`${v.viewCount.toLocaleString()} views`:null].filter(Boolean).join(' • ')||'Video',video:v}));
    renderDiscovery(items,category);
    discoverNote.textContent=`Live suggestions • ${items.length} videos`;
  }catch(_){
    renderDiscovery([],category);
    discoverNote.textContent='Suggestions unavailable';
  }
}

document.querySelectorAll('.category-tab').forEach(btn=>btn.addEventListener('click',()=>loadDiscovery(btn.dataset.category)));
document.getElementById('refreshDiscover')?.addEventListener('click',()=>loadDiscovery(activeDiscovery));
discoverGrid?.addEventListener('click',e=>{
  const search=e.target.closest('[data-discover-search]');
  if(search){setSource('search');const input=document.getElementById('searchInput');input.value=search.dataset.discoverSearch;document.getElementById('searchBtn')?.click();document.getElementById('download')?.scrollIntoView({behavior:'smooth'});return;}
  const watch=e.target.closest('[data-discover-watch]');
  if(watch){location.href=`/watch?url=${encodeURIComponent(watch.dataset.discoverWatch)}`;return;}
  const dl=e.target.closest('[data-discover-download]');
  if(dl){openQualityChooser(dl.dataset.discoverDownload,dl.closest('.discover-card')?.querySelector('h4')?.textContent||'Video');return;}
  const thumb=e.target.closest('[data-discover-stream]');
  if(thumb){openPlayer(thumb.dataset.discoverStream,thumb.closest('.discover-card')?.querySelector('h4')?.textContent||'Video');}
});
let previewTimer=null;
let previewVideo=null;
function stopPreview(el){if(previewTimer){clearTimeout(previewTimer);previewTimer=null} if(previewVideo){previewVideo.pause();previewVideo.remove();previewVideo=null} const img=el?.querySelector('img');if(img)img.style.display='block';}
function startHoverPreview(el){if(!el)return;stopPreview(el);const src=el.dataset.previewUrl;if(!src)return;previewTimer=setTimeout(async()=>{const v=document.createElement('video');v.muted=true;v.playsInline=true;v.autoplay=true;v.preload='metadata';v.className='hover-preview-video';v.src=`/api/stream?url=${encodeURIComponent(src)}&quality=best`;v.addEventListener('error',()=>{v.remove();previewVideo=null});el.appendChild(v);const img=el.querySelector('img');if(img)img.style.display='none';previewVideo=v;try{await v.play()}catch(_){}} ,900)}
searchResults?.addEventListener('pointerover',e=>{const el=e.target.closest('[data-preview-url]');if(el)startHoverPreview(el)});
searchResults?.addEventListener('pointerout',e=>{const el=e.target.closest('[data-preview-url]');if(el&&!el.contains(e.relatedTarget))stopPreview(el)});
loadDiscovery('home');
(() => { const p=new URLSearchParams(location.search); const incoming=p.get('download'); if(!incoming)return; url.value=incoming; setSource('link'); setTimeout(async()=>{const data=await analyzeWithBackend(incoming); const qv=p.get('quality'); const q=$('#quality'); if(data&&qv&&q&&[...q.options].some(o=>o.value===qv)){q.value=qv;document.querySelectorAll('.quality-chip').forEach(x=>x.classList.toggle('active',x.dataset.quality===qv));$('#stickyQuality').textContent=qv;}},60); })();
