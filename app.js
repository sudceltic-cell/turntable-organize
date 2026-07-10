document.addEventListener('DOMContentLoaded', () => {
  // ===================== STATE =====================
  const state = {
    screen: 'picker',
    release: {
      id: crypto.randomUUID?.() ?? 'rel-1',
      type: '',
      title: '',
      coverFileName: null,
      coverObjectURL: null,
      tracks: []
    },
    editingTrackId: null,
    audioCtx: null,
    activePlayers: {},
    playQueue: [],
    undoDelete: null
  };

  const $ = id => document.getElementById(id);
  const screens = { picker: $('screen-picker'), setup: $('screen-setup'), tracklist: $('screen-tracklist') };
  const tonearm = $('tonearm');
  const coverPreview = $('cover-preview');
  const coverReattachArea = $('cover-reattach-area');
  const inputReleaseTitle = $('input-release-title');
  const releaseTitleDisplay = $('release-title-display');
  const trackContainer = $('track-container');
  const statsTracks = $('stat-tracks');
  const statsHours = $('stat-hours');
  const statsRuntime = $('stat-runtime');
  const modalTrack = $('modal-track');
  const videoLightbox = $('video-lightbox');
  const lightboxVideo = $('lightbox-video');
  const saveIndicator = $('save-indicator');

  // Track modal fields
  const trackModalFields = {
    title: $('track-title'), lyrics: $('track-lyrics'), bpm: $('track-bpm'), key: $('track-key'),
    hours: $('track-hours'), mood: $('track-mood'),
    progLyrics: $('prog-lyrics'), progRecorded: $('prog-recorded'), progMixed: $('prog-mixed'), progMastered: $('prog-mastered'),
    collab: $('track-collab'), producer: $('track-producer'), freestyle: $('track-freestyle'), remix: $('track-remix'),
    notes: $('track-notes'), audio: $('track-audio'), cover: $('track-cover'), video: $('track-video')
  };

  // ===================== SCREEN MANAGEMENT =====================
  function showScreen(name) {
    Object.values(screens).forEach(el => el.classList.remove('active'));
    screens[name].classList.add('active');
    state.screen = name;
    if (name === 'setup') refreshSetupScreen();
    if (name === 'tracklist') renderTracklist();
  }

  // ===================== PICKER =====================
  const angleMap = { Track: -35, EP: 35, Mixtape: 145, Album: -145 };
  function animateNeedle(type) {
    return new Promise(resolve => {
      tonearm.style.transform = `rotate(${angleMap[type] || 0}deg)`;
      tonearm.classList.add('drop');
      setTimeout(() => { tonearm.classList.remove('drop'); resolve(); }, 800);
    });
  }
  document.querySelectorAll('.label').forEach(l => {
    l.addEventListener('click', async e => {
      state.release.type = e.currentTarget.dataset.type;
      await animateNeedle(state.release.type);
      showScreen('setup');
    });
  });

  // ===================== SETUP =====================
  function refreshSetupScreen() {
    inputReleaseTitle.value = state.release.title || '';
    updateCoverUI();
  }
  function updateCoverUI() {
    if (state.release.coverObjectURL) coverPreview.innerHTML = `<img src="${state.release.coverObjectURL}">`;
    else if (state.release.coverFileName) coverPreview.innerHTML = `<span style="color:#999;">📷 ${state.release.coverFileName}</span>`;
    else coverPreview.innerHTML = '<span style="color:#555;">No cover</span>';
    coverReattachArea.innerHTML = '';
    if (state.release.coverFileName && !state.release.coverObjectURL) {
      const btn = document.createElement('button'); btn.className='reattach-badge'; btn.textContent='⚠ Reattach cover';
      btn.onclick = () => {
        const inp = document.createElement('input'); inp.type='file'; inp.accept='image/*';
        inp.onchange = e => {
          const file = e.target.files[0];
          if (file) {
            if (state.release.coverObjectURL) URL.revokeObjectURL(state.release.coverObjectURL);
            state.release.coverObjectURL = URL.createObjectURL(file);
            state.release.coverFileName = file.name;
            updateCoverUI(); saveToStorage();
          }
        };
        inp.click();
      };
      coverReattachArea.appendChild(btn);
    }
  }
  $('input-cover-image').addEventListener('change', e => {
    const file = e.target.files[0];
    if (file) {
      if (state.release.coverObjectURL) URL.revokeObjectURL(state.release.coverObjectURL);
      state.release.coverObjectURL = URL.createObjectURL(file);
      state.release.coverFileName = file.name;
      updateCoverUI(); saveToStorage();
    }
  });
  $('btn-setup-next').addEventListener('click', () => {
    state.release.title = inputReleaseTitle.value.trim() || 'Untitled Release';
    releaseTitleDisplay.textContent = state.release.title;
    saveToStorage(); showScreen('tracklist');
  });
  $('btn-back-to-picker').addEventListener('click', () => { showScreen('picker'); tonearm.style.transform = 'rotate(0deg)'; });

  // ===================== AUDIO =====================
  function getAudioCtx() {
    if (!state.audioCtx) state.audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    if (state.audioCtx.state === 'suspended') state.audioCtx.resume();
    return state.audioCtx;
  }
  async function loadAudioForTrack(trackId, file) {
    const track = state.release.tracks.find(t => t.id === trackId);
    if (!track) return;
    const ctx = getAudioCtx();
    const buffer = await file.arrayBuffer().then(ab => ctx.decodeAudioData(ab));
    track._audioBuffer = buffer; track._duration = buffer.duration;
    stopTrack(trackId); renderTracklist(); saveToStorage();
  }
  function drawWaveform(canvas, audioBuffer) {
    if (!canvas || !audioBuffer) return;
    const ctx = canvas.getContext('2d');
    const width = canvas.width = canvas.offsetWidth;
    const height = canvas.height = canvas.offsetHeight;
    const data = audioBuffer.getChannelData(0);
    const step = Math.ceil(data.length / width);
    const amp = height / 2;
    ctx.clearRect(0,0,width,height);
    ctx.beginPath(); ctx.strokeStyle='#9b111e'; ctx.lineWidth=1.4;
    for (let i=0; i<width; i++) {
      let min=1.0, max=-1.0;
      for (let j=0; j<step; j++) { const d=data[(i*step)+j]||0; if(d<min)min=d; if(d>max)max=d; }
      ctx.moveTo(i+0.5, (1+min)*amp); ctx.lineTo(i+0.5, (1+max)*amp);
    }
    ctx.stroke();
  }

  // ===================== PLAYBACK =====================
  function stopTrack(trackId) { const p = state.activePlayers[trackId]; if(p){ try{p.source.stop();}catch(e){} delete state.activePlayers[trackId]; } }
  function playTrack(trackId, offset=0) {
    const track = state.release.tracks.find(t => t.id === trackId);
    if (!track || !track._audioBuffer) return;
    stopTrack(trackId);
    const ctx = getAudioCtx();
    const source = ctx.createBufferSource(); source.buffer = track._audioBuffer; source.connect(ctx.destination);
    source.start(0, offset);
    state.activePlayers[trackId] = { source, startTime: ctx.currentTime, offset };
    source.onended = () => {
      delete state.activePlayers[trackId];
      if (state.playQueue.length) playTrack(state.playQueue.shift(), 0);
      renderTracklist();
    };
    renderTracklist();
  }
  function togglePlayPause(trackId) {
    if (state.activePlayers[trackId]) {
      const p = state.activePlayers[trackId]; p.offset += getAudioCtx().currentTime - p.startTime;
      stopTrack(trackId);
    } else {
      const track = state.release.tracks.find(t => t.id === trackId);
      playTrack(trackId, track._playOffset || 0);
    }
  }
  function playAllTracks() {
    const tracks = [...state.release.tracks].sort((a,b)=>a.order-b.order).filter(t=>t._audioBuffer);
    if (!tracks.length) return;
    state.playQueue = tracks.slice(1).map(t=>t.id);
    playTrack(tracks[0].id, 0);
  }
  function seekTrack(trackId, percent) {
    const track = state.release.tracks.find(t => t.id === trackId);
    if (!track || !track._audioBuffer) return;
    const newTime = percent * track._audioBuffer.duration;
    if (state.activePlayers[trackId]) { stopTrack(trackId); playTrack(trackId, newTime); }
    else { track._playOffset = newTime; renderTracklist(); }
  }

  // ===================== TRACK MODAL =====================
  function openTrackModal(trackId=null) {
    state.editingTrackId = trackId;
    $('modal-title').textContent = trackId ? 'Edit Track' : 'Add Track';
    Object.values(trackModalFields).forEach(f => {
      if (!f) return;
      if (f.type === 'checkbox') f.checked = false;
      else if (f.tagName === 'INPUT' || f.tagName === 'TEXTAREA') f.value = '';
    });
    if (trackId) {
      const t = state.release.tracks.find(t => t.id === trackId);
      if (t) {
        trackModalFields.title.value = t.title || '';
        trackModalFields.lyrics.value = t.lyrics || '';
        trackModalFields.bpm.value = t.bpm ?? '';
        trackModalFields.key.value = t.key || '';
        trackModalFields.hours.value = t.hours ?? '';
        trackModalFields.mood.value = t.mood || '';
        trackModalFields.progLyrics.checked = t.progress?.lyricsWritten || false;
        trackModalFields.progRecorded.checked = t.progress?.recorded || false;
        trackModalFields.progMixed.checked = t.progress?.mixed || false;
        trackModalFields.progMastered.checked = t.progress?.mastered || false;
        trackModalFields.collab.value = t.collaborators || '';
        trackModalFields.producer.value = t.producer || '';
        trackModalFields.freestyle.checked = t.freestyle || false;
        trackModalFields.remix.checked = t.remix || false;
        trackModalFields.notes.value = t.notes || '';
      }
    }
    modalTrack.style.display = 'flex';
  }
  function closeTrackModal() { modalTrack.style.display = 'none'; state.editingTrackId = null; }
  $('modal-cancel').addEventListener('click', closeTrackModal);
  $('modal-save').addEventListener('click', () => {
    const title = trackModalFields.title.value.trim();
    if (!title) { alert('Track title required.'); return; }
    let track;
    if (state.editingTrackId) track = state.release.tracks.find(t => t.id === state.editingTrackId);
    else {
      track = { id: crypto.randomUUID?.() ?? Date.now().toString(36), order: state.release.tracks.length };
      state.release.tracks.push(track);
    }
    track.title = title;
    track.lyrics = trackModalFields.lyrics.value;
    track.bpm = parseFloat(trackModalFields.bpm.value) || null;
    track.key = trackModalFields.key.value.trim();
    track.hours = parseFloat(trackModalFields.hours.value) || 0;
    track.mood = trackModalFields.mood.value.trim();
    track.progress = {
      lyricsWritten: trackModalFields.progLyrics.checked,
      recorded: trackModalFields.progRecorded.checked,
      mixed: trackModalFields.progMixed.checked,
      mastered: trackModalFields.progMastered.checked
    };
    track.collaborators = trackModalFields.collab.value.trim();
    track.producer = trackModalFields.producer.value.trim();
    track.freestyle = trackModalFields.freestyle.checked;
    track.remix = trackModalFields.remix.checked;
    track.notes = trackModalFields.notes.value.trim();

    const audioFile = trackModalFields.audio.files[0];
    const coverFile = trackModalFields.cover.files[0];
    const videoFile = trackModalFields.video.files[0];
    if (audioFile) { track.audioFileName = audioFile.name; loadAudioForTrack(track.id, audioFile); }
    if (coverFile) {
      if (track.customCoverObjectURL) URL.revokeObjectURL(track.customCoverObjectURL);
      track.customCoverObjectURL = URL.createObjectURL(coverFile);
      track.customCoverFileName = coverFile.name;
    }
    if (videoFile) {
      if (track.videoObjectURL) URL.revokeObjectURL(track.videoObjectURL);
      track.videoObjectURL = URL.createObjectURL(videoFile);
      track.videoFileName = videoFile.name;
    }
    closeTrackModal(); saveToStorage(); renderTracklist();
  });

  // ===================== DELETE & UNDO =====================
  function deleteTrack(trackId) {
    const idx = state.release.tracks.findIndex(t => t.id === trackId);
    if (idx === -1) return;
    const [removed] = state.release.tracks.splice(idx, 1);
    stopTrack(trackId);
    state.undoDelete = { track: removed, index: idx };
    const existing = document.querySelector('.toast'); if (existing) existing.remove();
    const toast = document.createElement('div'); toast.className='toast';
    toast.innerHTML = `Track deleted. <button class="undo-btn">Undo</button>`;
    toast.querySelector('.undo-btn').addEventListener('click', () => {
      if (state.undoDelete) {
        state.release.tracks.splice(state.undoDelete.index, 0, state.undoDelete.track);
        state.undoDelete = null; saveToStorage(); renderTracklist();
      }
      toast.remove();
    });
    document.body.appendChild(toast);
    setTimeout(() => { if (toast.parentNode) toast.remove(); }, 5000);
    saveToStorage(); renderTracklist();
  }

  // ===================== RENDER TRACKLIST =====================
  function renderTracklist() {
    const tracks = [...state.release.tracks].sort((a,b) => a.order - b.order);
    statsTracks.textContent = tracks.length;
    statsHours.textContent = tracks.reduce((s,t)=>s+(t.hours||0),0).toFixed(1);
    const totalSec = tracks.reduce((s,t)=>s+(t._duration||0),0);
    statsRuntime.textContent = `${Math.floor(totalSec/60)}:${String(Math.floor(totalSec%60)).padStart(2,'0')}`;

    trackContainer.innerHTML = '';
    tracks.forEach((track, idx) => {
      const progress = track.progress || {};
      const progressHTML = ['lyricsWritten','recorded','mixed','mastered'].map(k =>
        `<span class="progress-step ${progress[k]?'done':''}" title="${k}"></span>`).join('');
      const durText = track._duration ? `${Math.floor(track._duration/60)}:${String(Math.floor(track._duration%60)).padStart(2,'0')}` : '';
      const isPlaying = !!state.activePlayers[track.id];
      const collabStr = track.collaborators ? `<span class="tag">👥 ${track.collaborators}</span>` : '';
      const producerStr = track.producer ? `<span class="tag">🎛️ ${track.producer}</span>` : '';
      const typeTags = [];
      if (track.freestyle) typeTags.push('<span class="tag">🔥 Freestyle</span>');
      if (track.remix) typeTags.push('<span class="tag">🔄 Remix</span>');

      const card = document.createElement('div');
      card.className = 'track-card'; card.draggable = true; card.dataset.id = track.id;
      card.innerHTML = `
        <div class="card-thumb">${track.customCoverObjectURL ? `<img src="${track.customCoverObjectURL}">` : '<span style="font-size:1.8rem;">🎵</span>'}</div>
        <div class="card-body">
          <div class="track-title">${track.title} <span class="playing-indicator ${isPlaying?'active':''}"></span></div>
          <div class="tag-list">
            ${track.bpm ? `<span class="tag">${track.bpm} BPM</span>` : ''}
            ${track.key ? `<span class="tag">${track.key}</span>` : ''}
            <span class="tag">${track.hours}h</span>
            ${track.mood ? `<span class="tag mood-tag">${track.mood}</span>` : ''}
            ${collabStr} ${producerStr} ${typeTags.join('')}
          </div>
          <div class="progress-track">${progressHTML}</div>
          <div class="waveform-container" data-trackid="${track.id}">
            <canvas class="waveform" id="wave-${track.id}"></canvas>
            <div class="progress-line" id="prog-${track.id}" style="display:${isPlaying?'block':'none'}"></div>
            ${durText ? `<span class="duration-tag">${durText}</span>` : ''}
          </div>
          <div class="card-actions">
            <button class="btn btn-sm play-btn" data-id="${track.id}">${isPlaying ? '⏸ Pause' : '▶ Play'}</button>
            <button class="btn btn-sm btn-outline edit-btn" data-id="${track.id}">✎</button>
            <button class="btn btn-sm btn-outline delete-btn" data-id="${track.id}">🗑</button>
            <button class="btn btn-sm btn-outline up-btn" data-id="${track.id}" ${idx===0?'disabled':''}>▲</button>
            <button class="btn btn-sm btn-outline down-btn" data-id="${track.id}" ${idx===tracks.length-1?'disabled':''}>▼</button>
            <button class="btn btn-sm btn-outline lyrics-toggle" data-id="${track.id}">📜</button>
            ${track.videoObjectURL ? `<button class="btn btn-sm btn-outline video-btn" data-id="${track.id}">🎬 Video</button>` : ''}
            <span id="reattach-${track.id}"></span>
          </div>
          <div class="lyrics-panel" id="lyrics-${track.id}">${track.lyrics || 'No lyrics yet.'}</div>
          ${track.notes ? `<div style="font-size:0.8rem; color:#999; margin-top:0.4rem;">📝 ${track.notes}</div>` : ''}
        </div>
      `;
      trackContainer.appendChild(card);

      const canvas = card.querySelector(`#wave-${track.id}`);
      if (track._audioBuffer) {
        drawWaveform(canvas, track._audioBuffer);
        if (isPlaying) animateProgress(track.id);
      } else {
        const playBtn = card.querySelector('.play-btn'); if (playBtn) playBtn.disabled = true;
      }

      const reattachDiv = card.querySelector(`#reattach-${track.id}`);
      if (track.audioFileName && !track._audioBuffer) {
        const b = document.createElement('button'); b.className='reattach-badge'; b.textContent='⚠ Audio'; b.onclick=()=>reattachFile(track.id,'audio'); reattachDiv.appendChild(b);
      }
      if (track.customCoverFileName && !track.customCoverObjectURL) {
        const b = document.createElement('button'); b.className='reattach-badge'; b.textContent='⚠ Cover'; b.onclick=()=>reattachFile(track.id,'cover'); reattachDiv.appendChild(b);
      }
      if (track.videoFileName && !track.videoObjectURL) {
        const b = document.createElement('button'); b.className='reattach-badge'; b.textContent='⚠ Video'; b.onclick=()=>reattachFile(track.id,'video'); reattachDiv.appendChild(b);
      }
    });

    // Delegate events
    trackContainer.querySelectorAll('.play-btn').forEach(b => b.onclick = e => togglePlayPause(e.target.dataset.id));
    trackContainer.querySelectorAll('.edit-btn').forEach(b => b.onclick = e => openTrackModal(e.target.dataset.id));
    trackContainer.querySelectorAll('.delete-btn').forEach(b => b.onclick = e => deleteTrack(e.target.dataset.id));
    trackContainer.querySelectorAll('.up-btn').forEach(b => b.onclick = e => moveTrack(e.target.dataset.id, -1));
    trackContainer.querySelectorAll('.down-btn').forEach(b => b.onclick = e => moveTrack(e.target.dataset.id, 1));
    trackContainer.querySelectorAll('.lyrics-toggle').forEach(b => b.onclick = e => {
      const panel = document.getElementById(`lyrics-${e.target.dataset.id}`);
      panel.classList.toggle('expanded');
    });
    trackContainer.querySelectorAll('.video-btn').forEach(b => b.onclick = e => {
      const t = state.release.tracks.find(t => t.id === e.target.dataset.id);
      if (t?.videoObjectURL) { lightboxVideo.src = t.videoObjectURL; videoLightbox.style.display='flex'; lightboxVideo.play(); }
    });
    trackContainer.querySelectorAll('.waveform-container').forEach(wf => {
      wf.addEventListener('click', e => {
        const rect = wf.getBoundingClientRect();
        const percent = (e.clientX - rect.left) / rect.width;
        const trackId = wf.dataset.trackid;
        seekTrack(trackId, Math.max(0, Math.min(1, percent)));
      });
    });

    // Drag & drop
    document.querySelectorAll('.track-card').forEach(card => {
      card.addEventListener('dragstart', handleDragStart);
      card.addEventListener('dragover', handleDragOver);
      card.addEventListener('dragleave', handleDragLeave);
      card.addEventListener('drop', handleDrop);
      card.addEventListener('dragend', handleDragEnd);
    });
  }

  let dragSrcId = null;
  function handleDragStart(e) { dragSrcId = e.currentTarget.dataset.id; e.dataTransfer.effectAllowed = 'move'; e.currentTarget.style.opacity = '0.4'; }
  function handleDragOver(e) { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; e.currentTarget.classList.add('drag-over'); }
  function handleDragLeave(e) { e.currentTarget.classList.remove('drag-over'); }
  function handleDrop(e) {
    e.preventDefault(); e.currentTarget.classList.remove('drag-over');
    const targetId = e.currentTarget.dataset.id;
    if (dragSrcId && targetId && dragSrcId !== targetId) reorderTracks(dragSrcId, targetId);
  }
  function handleDragEnd(e) { e.currentTarget.style.opacity = '1'; document.querySelectorAll('.track-card').forEach(c => c.classList.remove('drag-over')); }
  function reorderTracks(srcId, targetId) {
    const tracks = state.release.tracks;
    const srcIdx = tracks.findIndex(t => t.id === srcId), targetIdx = tracks.findIndex(t => t.id === targetId);
    if (srcIdx===-1 || targetIdx===-1) return;
    const [moved] = tracks.splice(srcIdx,1); tracks.splice(targetIdx,0,moved);
    tracks.forEach((t,i) => t.order = i); saveToStorage(); renderTracklist();
  }
  function moveTrack(id, dir) {
    const tracks = state.release.tracks; const idx = tracks.findIndex(t => t.id === id);
    if (idx===-1) return; const newIdx = idx + dir;
    if (newIdx<0 || newIdx>=tracks.length) return;
    [tracks[idx], tracks[newIdx]] = [tracks[newIdx], tracks[idx]];
    tracks.forEach((t,i) => t.order = i); saveToStorage(); renderTracklist();
  }

  function animateProgress(trackId) {
    const player = state.activePlayers[trackId];
    const track = state.release.tracks.find(t => t.id === trackId);
    const prog = document.getElementById(`prog-${trackId}`);
    if (!player || !track?._audioBuffer) { if(prog) prog.style.display='none'; return; }
    const ctx = getAudioCtx();
    const elapsed = player.offset + (ctx.currentTime - player.startTime);
    const dur = track._audioBuffer.duration;
    const percent = Math.min((elapsed/dur)*100, 100);
    if (prog) { prog.style.left = percent+'%'; prog.style.display='block'; }
    if (elapsed < dur) requestAnimationFrame(() => animateProgress(trackId));
    else if (prog) prog.style.display='none';
  }

  function reattachFile(trackId, type) {
    const track = state.release.tracks.find(t => t.id === trackId); if (!track) return;
    const input = document.createElement('input'); input.type='file';
    if (type==='audio') input.accept='audio/*'; else if (type==='cover') input.accept='image/*'; else if (type==='video') input.accept='video/*';
    input.onchange = async e => {
      const file = e.target.files[0]; if (!file) return;
      if (type==='audio') { track.audioFileName = file.name; await loadAudioForTrack(trackId, file); }
      else if (type==='cover') {
        if (track.customCoverObjectURL) URL.revokeObjectURL(track.customCoverObjectURL);
        track.customCoverObjectURL = URL.createObjectURL(file); track.customCoverFileName = file.name;
      } else if (type==='video') {
        if (track.videoObjectURL) URL.revokeObjectURL(track.videoObjectURL);
        track.videoObjectURL = URL.createObjectURL(file); track.videoFileName = file.name;
      }
      saveToStorage(); renderTracklist();
    };
    input.click();
  }

  // ===================== EXPORT =====================
  $('btn-export').addEventListener('click', () => {
    const tracks = [...state.release.tracks].sort((a,b) => a.order - b.order);
    let html = `<html><head><title>${state.release.title} - Release Sheet</title>
    <style>body{font-family:system-ui;background:#fff;color:#111;padding:2rem;} h1{color:#9b111e;} .track{margin-bottom:2rem;} .tag{display:inline-block;background:#eee;padding:0.2rem 0.5rem;border-radius:4px;margin-right:0.3rem;} .lyrics{white-space:pre-wrap;font-style:italic;color:#333;margin-top:0.5rem;}</style></head><body>
    <h1>${state.release.title} (${state.release.type})</h1>
    ${tracks.map(t => `
      <div class="track"><h2>${t.title}</h2>
      <div>${t.bpm?`<span class="tag">${t.bpm} BPM</span>`:''} ${t.key?`<span class="tag">Key: ${t.key}</span>`:''} ${t.mood?`<span class="tag">${t.mood}</span>`:''} ${t.hours?`<span class="tag">${t.hours}h</span>`:''} ${t.collaborators?`<span class="tag">👥 ${t.collaborators}</span>`:''} ${t.producer?`<span class="tag">🎛️ ${t.producer}</span>`:''}</div>
      ${t.lyrics?`<div class="lyrics">${t.lyrics}</div>`:''} ${t.notes?`<p>📝 ${t.notes}</p>`:''}</div>
    `).join('')}
    </body></html>`;
    const w = window.open('', '_blank'); w.document.write(html); w.document.close();
  });

  // ===================== KEYBOARD SHORTCUTS =====================
  document.addEventListener('keydown', e => {
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.isContentEditable) return;
    if (e.key === 'n' || e.key === 'N') { if (state.screen === 'tracklist') { e.preventDefault(); openTrackModal(); } }
    else if (e.key === 'Escape') {
      if (modalTrack.style.display === 'flex') closeTrackModal();
      else if (videoLightbox.style.display === 'flex') { lightboxVideo.pause(); lightboxVideo.src = ''; videoLightbox.style.display = 'none'; }
    } else if (e.code === 'Space' && state.screen === 'tracklist') {
      e.preventDefault(); const playingId = Object.keys(state.activePlayers)[0]; if (playingId) togglePlayPause(playingId);
    }
  });

  $('btn-play-all').addEventListener('click', playAllTracks);

  // ===================== SAVE INDICATOR =====================
  function flashSaveIndicator() { saveIndicator.style.opacity='1'; clearTimeout(saveIndicator._timeout); saveIndicator._timeout = setTimeout(() => saveIndicator.style.opacity='0', 1200); }

  // ===================== PERSISTENCE =====================
  const STORAGE_KEY = 'turntable_release_pro';
  function saveToStorage() {
    const toSave = {
      id: state.release.id, type: state.release.type, title: state.release.title,
      coverFileName: state.release.coverFileName,
      tracks: state.release.tracks.map(t => ({
        id: t.id, order: t.order, title: t.title, lyrics: t.lyrics,
        bpm: t.bpm, key: t.key, hours: t.hours, mood: t.mood,
        progress: t.progress, collaborators: t.collaborators, producer: t.producer,
        freestyle: t.freestyle, remix: t.remix, notes: t.notes,
        audioFileName: t.audioFileName||null, customCoverFileName: t.customCoverFileName||null,
        videoFileName: t.videoFileName||null, _duration: t._duration||null, _playOffset:0
      }))
    };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(toSave));
    flashSaveIndicator();
  }

  function loadFromStorage() {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return;
    try {
      const data = JSON.parse(raw);
      state.release.id = data.id; state.release.type = data.type||'';
      state.release.title = data.title||''; state.release.coverFileName = data.coverFileName||null;
      state.release.coverObjectURL = null;
      state.release.tracks = (data.tracks||[]).map(t => ({
        ...t, progress: t.progress||{ lyricsWritten:false, recorded:false, mixed:false, mastered:false },
        collaborators: t.collaborators||'', producer: t.producer||'',
        freestyle: t.freestyle||false, remix: t.remix||false, notes: t.notes||'',
        _audioBuffer: null, _playOffset:0, customCoverObjectURL:null, videoObjectURL:null,
        _duration: t._duration||null
      }));
      releaseTitleDisplay.textContent = state.release.title || 'Untitled';
      updateCoverUI();
    } catch(e) { console.error('Load error', e); }
  }

  // ===================== INIT =====================
  $('btn-back-to-setup').addEventListener('click', () => showScreen('setup'));
  $('btn-add-track').addEventListener('click', () => openTrackModal(null));

  $('close-lightbox').addEventListener('click', () => {
    lightboxVideo.pause(); lightboxVideo.src = ''; videoLightbox.style.display = 'none';
  });
  videoLightbox.addEventListener('click', e => {
    if (e.target === videoLightbox) { lightboxVideo.pause(); lightboxVideo.src = ''; videoLightbox.style.display = 'none'; }
  });

  loadFromStorage();
  showScreen('picker');
});