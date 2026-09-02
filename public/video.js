// ============ Video Editing (Seedance 2.5) ============
// Drives BytePlus ModelArk contents/generations/tasks: the server creates an
// async edit task, the client polls /api/video/tasks/:id until terminal, and the
// server downloads the produced clip. This module handles lifecycle + rendering.
(function () {
    const $ = (id) => document.getElementById(id);
    const showToast = (m, k) => window.Studio?.showToast(m, k);

    // --- DOM ---
    const dropZone = $('vidDropZone');
    const fileInput = $('vidFileInput');
    const browseBtn = $('vidBrowseBtn');
    const urlInput = $('vidUrlInput');
    const fileStrip = $('vidFileStrip');
    const promptInput = $('vidPromptInput');
    const imgDropZone = $('vidImgDropZone');
    const generateBtn = $('vidGenerateBtn');
    const processingPool = $('vidProcessingPool');
    const gallery = $('vidGallery');
    const galleryEmpty = $('vidGalleryEmpty');
    const galleryCount = $('vidGalleryCount');
    const refreshBtn = $('vidRefreshBtn');

    const lightbox = $('vidLightbox');
    const lbClose = $('vidLightboxClose');
    const player = $('vidLightboxPlayer');
    const lbPrompt = $('vlbPrompt');
    const lbModel = $('vlbModel');
    const lbRatio = $('vlbRatio');
    const lbResolution = $('vlbResolution');
    const lbCreated = $('vlbCreated');
    const lbDuration = $('vlbDuration');
    const lbAudio = $('vlbAudio');
    const soundBtn = $('vidSoundBtn');
    const lbDownload = $('vlbDownload');
    const lbDelete = $('vlbDelete');
    const lbTitle = $('vlbTitle');
    const lbPromptLabel = $('vlbPromptLabel');
    const lbMode = $('vlbMode');
    const lbFrames = $('vlbFrames');
    const lbFirstImg = $('vlbFirstImg');
    const lbLastImg = $('vlbLastImg');
    const lbLastFig = $('vlbLastFig');

    // Remembers which clips were saved this page load so a repeat activation (a double
    // click, or the Enter shortcut on an already-saved clip) is blocked with a toast
    // instead of re-triggering the browser download. In-memory only: cleared on reload.
    const downloadedVideos = new Set();
    function activateVideoDownload(event) {
        disarmDelete(); // choosing to download is a different intent — cancel any pending delete
        const href = lbDownload.href;
        if (!href) { event.preventDefault(); return; }
        if (downloadedVideos.has(href)) {
            event.preventDefault();
            showToast('Already downloaded.', '');
            return;
        }
        downloadedVideos.add(href);
    }
    lbDownload.addEventListener('click', activateVideoDownload);

    const uploadNotice = $('vidUploadNotice');
    const uploadNoticeUrl = $('vidUploadNoticeUrl');

    // Mode switching
    const modeToggle = $('vidModeToggle');
    const editInputs = $('vidEditInputs');
    const frameInputs = $('vidFrameInputs');
    const genControls = $('vidGenControls');
    const ratioControl = $('vidRatioControl');
    const ratioNote = $('vidRatioNote');
    const refImageBlock = $('vidRefImageBlock');
    const firstDropZone = $('vidFirstDropZone');
    const lastDropZone = $('vidLastDropZone');
    const hintEdit = $('vidModeHintEdit');
    const hintEditDetail = $('vidModeHintEditDetail');
    const hintRef = $('vidModeHintRef');
    const hintFrames = $('vidModeHintFrames');
    const composerTitle = $('vidComposerTitle');
    const promptLabel = $('vidPromptLabel');
    const generateLabel = $('vidGenerateLabel');

    // --- State ---
    let videoFile = null;
    // 'edit' = imitate a reference clip; 'firstLast' = generate from keyframe images.
    // The API refuses to mix the two, so switching modes clears the other side's files.
    let mode = 'edit';
    // Uploads require a publicly-reachable server (PUBLIC_BASE_URL); until health
    // confirms that, the dropzones are inert and only pasted URLs work.
    let uploadsEnabled = false;
    let items = [];          // manifest records (newest first)
    const pending = new Set(); // taskIds still being polled

    // ---------- Reference video handling ----------
    function setVideoFile(file) {
        if (!file) return;
        if (!uploadsEnabled) {
            showToast('Uploads paused — public tunnel reconnecting. Retry shortly, or paste a URL.', 'error');
            return;
        }
        if (!file.type.startsWith('video/')) { showToast('Pick a video file.', 'error'); return; }
        videoFile = file;
        // A pasted URL is overridden by an explicit upload.
        urlInput.value = '';
        renderVideoFile();
        refreshControls();
    }
    function renderVideoFile() {
        fileStrip.innerHTML = '';
        if (!videoFile) return;
        const chip = document.createElement('div');
        chip.className = 'thumb thumb-wide';
        const name = document.createElement('span');
        name.className = 'thumb-label';
        name.textContent = videoFile.name;
        const btn = document.createElement('button');
        btn.className = 'remove'; btn.textContent = '×'; btn.title = 'Remove';
        btn.addEventListener('click', (e) => {
            e.stopPropagation(); videoFile = null; renderVideoFile(); refreshControls();
        });
        chip.append(name, btn);
        fileStrip.appendChild(chip);
    }

    // Drag/drop on the video dropzone
    ['dragenter', 'dragover'].forEach(ev => dropZone.addEventListener(ev, (e) => {
        e.preventDefault(); e.stopPropagation(); dropZone.classList.add('drag-over');
    }));
    ['dragleave', 'drop'].forEach(ev => dropZone.addEventListener(ev, (e) => {
        e.preventDefault(); e.stopPropagation(); dropZone.classList.remove('drag-over');
    }));
    dropZone.addEventListener('drop', (e) => {
        const f = e.dataTransfer?.files?.[0];
        if (f) setVideoFile(f);
    });
    dropZone.addEventListener('click', (e) => {
        if (e.target.tagName === 'BUTTON') return;
        fileInput.click();
    });
    dropZone.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fileInput.click(); }
    });
    browseBtn.addEventListener('click', (e) => { e.stopPropagation(); fileInput.click(); });
    fileInput.addEventListener('change', () => {
        if (fileInput.files?.[0]) setVideoFile(fileInput.files[0]);
        fileInput.value = '';
    });
    // Typing (or clearing) a URL flips the subtask just as an upload does.
    urlInput.addEventListener('input', () => refreshControls());
    // Pasting a local file targets the video composer: a clip in edit mode, an image
    // into the first empty keyframe slot in frame mode.
    window.addEventListener('paste', (e) => {
        if ($('videoView').classList.contains('hidden')) return;
        const files = Array.from(e.clipboardData?.files || []);
        if (mode === 'firstLast') {
            const img = files.find(f => f.type.startsWith('image/'));
            if (!img) return;
            const slot = firstFrameSlot.file ? lastFrameSlot : firstFrameSlot;
            if (slot.set(img)) {
                showToast(slot === firstFrameSlot ? 'Pasted first frame.' : 'Pasted last frame.', 'success');
            }
            return;
        }
        const f = files.find(f => f.type.startsWith('video/'));
        if (f) { setVideoFile(f); showToast('Pasted reference video.', 'success'); }
    });

    // ---------- Image slots (reference image, first frame, last frame) ----------
    // Three structurally identical single-image dropzones, so they share one factory
    // rather than three copies of the same drag/drop + browse + chip-render code.
    function makeImageSlot({ zone, input, browse, strip, onChange }) {
        const dz = $(zone), fi = $(input), bb = $(browse), st = $(strip);
        const slot = { file: null };
        const changed = () => { if (onChange) onChange(); };

        function render() {
            st.innerHTML = '';
            if (!slot.file) return;
            const chip = document.createElement('div');
            chip.className = 'thumb';
            const img = document.createElement('img');
            img.src = URL.createObjectURL(slot.file);
            img.onload = () => URL.revokeObjectURL(img.src);
            const btn = document.createElement('button');
            btn.className = 'remove'; btn.textContent = '×'; btn.title = 'Remove';
            btn.addEventListener('click', (e) => { e.stopPropagation(); slot.file = null; render(); changed(); });
            chip.append(img, btn);
            st.appendChild(chip);
        }
        slot.set = (f) => {
            if (!f || !f.type.startsWith('image/')) return false;
            if (!uploadsEnabled) {
                showToast('Uploads paused — public tunnel reconnecting. Retry shortly.', 'error');
                return false;
            }
            slot.file = f; render(); changed();
            return true;
        };
        slot.clear = () => { slot.file = null; render(); changed(); };

        ['dragenter', 'dragover'].forEach(ev => dz.addEventListener(ev, (e) => {
            e.preventDefault(); e.stopPropagation(); dz.classList.add('drag-over');
        }));
        ['dragleave', 'drop'].forEach(ev => dz.addEventListener(ev, (e) => {
            e.preventDefault(); e.stopPropagation(); dz.classList.remove('drag-over');
        }));
        dz.addEventListener('drop', (e) => slot.set(e.dataTransfer?.files?.[0]));
        dz.addEventListener('click', (e) => { if (e.target.tagName !== 'BUTTON') fi.click(); });
        dz.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fi.click(); }
        });
        bb.addEventListener('click', (e) => { e.stopPropagation(); fi.click(); });
        fi.addEventListener('change', () => { slot.set(fi.files?.[0]); fi.value = ''; });
        return slot;
    }

    const refImageSlot = makeImageSlot({
        zone: 'vidImgDropZone', input: 'vidImgInput',
        browse: 'vidImgBrowseBtn', strip: 'vidImgStrip',
        onChange: () => refreshControls()
    });
    const firstFrameSlot = makeImageSlot({
        zone: 'vidFirstDropZone', input: 'vidFirstInput',
        browse: 'vidFirstBrowseBtn', strip: 'vidFirstStrip'
    });
    const lastFrameSlot = makeImageSlot({
        zone: 'vidLastDropZone', input: 'vidLastInput',
        browse: 'vidLastBrowseBtn', strip: 'vidLastStrip'
    });

    // ---------- Mode switching ----------
    /**
     * Which upstream subtask the current inputs imply. Mirrors videoSubtask() on the
     * server; the server is still the authority, this only drives what the composer
     * offers so we never show a control the API would reject.
     */
    function currentSubtask() {
        if (mode === 'firstLast') return 'first_last';
        return (videoFile || urlInput.value.trim()) ? 'edit' : 'reference';
    }

    /**
     * Show only the parameters the implied subtask actually accepts. A reference clip
     * dictates ratio and duration; a lone reference image dictates neither; keyframes
     * dictate the ratio only.
     */
    function refreshControls() {
        const sub = currentSubtask();
        const showRow = sub !== 'edit';
        genControls.classList.toggle('hidden', !showRow);
        ratioControl.classList.toggle('hidden', sub !== 'reference');
        ratioNote.classList.toggle('hidden', sub !== 'first_last');

        // In edit mode the two hints swap depending on whether a clip is in play.
        if (mode === 'edit') {
            hintEditDetail.classList.toggle('hidden', sub !== 'edit');
            hintRef.classList.toggle('hidden', sub !== 'reference');
        }
    }

    function setMode(next) {
        if (next !== 'edit' && next !== 'firstLast') return;
        mode = next;
        const frames = mode === 'firstLast';

        modeToggle.querySelectorAll('.seg').forEach(b => {
            const on = b.dataset.mode === mode;
            b.classList.toggle('active', on);
            b.setAttribute('aria-selected', String(on));
        });

        editInputs.classList.toggle('hidden', frames);
        refImageBlock.classList.toggle('hidden', frames);
        frameInputs.classList.toggle('hidden', !frames);
        hintEdit.classList.toggle('hidden', frames);
        hintFrames.classList.toggle('hidden', !frames);
        if (frames) {
            hintEditDetail.classList.add('hidden');
            hintRef.classList.add('hidden');
        }

        // The "paste a URL instead" escape hatch only exists in edit mode.
        uploadNoticeUrl?.classList.toggle('hidden', frames);

        composerTitle.textContent = frames ? 'Frames to video' : 'Video edit';
        promptLabel.textContent = frames ? 'Motion prompt' : 'Edit instruction';
        promptInput.placeholder = frames
            ? 'Camera slowly pushes in as the sun sets; gentle wind in the trees.'
            : 'Make it look like a night scene in neon city; keep the camera moves, swap the actor for an anime girl.';
        generateLabel.textContent = frames ? 'Generate video' : 'Generate edit';

        // The API rejects frame inputs mixed with reference media, so the hidden
        // side is emptied rather than silently kept around.
        if (frames) {
            videoFile = null; renderVideoFile();
            urlInput.value = '';
            refImageSlot.clear();
        } else {
            firstFrameSlot.clear();
            lastFrameSlot.clear();
        }
        refreshControls();
    }
    modeToggle.addEventListener('click', (e) => {
        const btn = e.target.closest('.seg');
        if (btn) setMode(btn.dataset.mode);
    });
    // The markup already ships in edit state; running setMode once anyway keeps the
    // DOM and `mode` from drifting apart if either side is edited later.
    setMode(mode);

    // ---------- Generation ----------
    function makeCard(taskId, prompt) {
        const card = document.createElement('div');
        card.className = 'job-card';
        card.dataset.taskId = taskId;
        card.innerHTML = `
            <div class="skeleton"></div>
            <div class="job-meta">
                <span class="spinner"></span>
                <span class="prompt-preview">${escapeHtml(truncate(prompt, 60))}</span>
            </div>
            <div class="job-status">queued…</div>
        `;
        return card;
    }
    function cardSetStatus(card, text) {
        const el = card.querySelector('.job-status');
        if (el) el.textContent = text;
    }
    // Verbose, sticky error handling: the full message (with request id) is logged
    // to the browser console AND shown on the card until you dismiss it, so an
    // 8-second auto-clear can't swipe the error code away from under you.
    function videoLog(level, label, detail) {
        const tag = '%c[video] ' + label;
        const style = 'color:#ff5470;font-weight:600';
        // Always dump the full, untruncated object to the console — DevTools keeps it.
        if (level === 'error') console.error(tag, style, '\n', detail);
        else console.warn(tag, style, '\n', detail);
        // Also surface a plain-text copy in case the detail is an object.
        const flat = (typeof detail === 'string') ? detail : (detail && detail.message) || JSON.stringify(detail);
        if (flat) console.log('[video] ' + label + ': ' + flat);
    }
    function cardError(card, msg, opts = {}) {
        const full = (typeof msg === 'string') ? msg : (msg && msg.message) || JSON.stringify(msg);
        videoLog('error', 'task ' + (card.dataset.taskId || '') + ' failed', full);
        card.classList.add('error');
        const skel = card.querySelector('.skeleton');
        if (skel) {
            skel.textContent = full;
            // Error text is selectable + scrollable so you can read long codes.
            skel.style.textAlign = 'left';
            skel.style.alignItems = 'flex-start';
            skel.style.padding = '14px';
            skel.style.fontSize = '12px';
            skel.style.lineHeight = '1.45';
            skel.style.overflow = 'auto';
            skel.style.whiteSpace = 'pre-wrap';
            skel.style.wordBreak = 'break-word';
        }
        card.querySelector('.spinner')?.remove();
        card.querySelector('.job-status')?.remove();
        card.querySelector('.job-meta')?.insertAdjacentHTML('afterbegin', '<span style="color:var(--danger)">⚠</span> ');
        // Don't auto-remove — give the error a dismiss button instead.
        if (!card.querySelector('.card-dismiss')) {
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'ghost-btn card-dismiss';
            btn.textContent = 'Dismiss';
            btn.style.cssText = 'margin:8px 10px 10px;width:auto;align-self:flex-start;padding:4px 12px;font-size:12px;';
            btn.addEventListener('click', (e) => { e.stopPropagation(); card.remove(); });
            card.appendChild(btn);
        }
    }

    async function generate() {
        if (!window.Studio?.getVideoEnabled?.()) {
            showToast('Video editing is not configured on the server.', 'error');
            return;
        }
        const sub = currentSubtask();
        const frames = sub === 'first_last';
        const userMessage = promptInput.value.trim();
        if (!userMessage) {
            showToast(frames ? 'Describe the motion you want.' : 'Describe your edit.', 'error');
            promptInput.focus(); return;
        }
        if (frames) {
            if (!firstFrameSlot.file) { showToast('Add a first frame image.', 'error'); return; }
        } else if (sub === 'reference' && !refImageSlot.file) {
            // Neither a clip nor an image — edit mode needs one of the two.
            showToast('Add a reference video or a reference image.', 'error'); return;
        }

        const fd = new FormData();
        fd.append('userMessage', userMessage);
        fd.append('mode', mode);
        fd.append('model', $('vidModelSelect').value);
        fd.append('resolution', $('vidResolutionSelect').value);
        fd.append('watermark', String($('vidWatermarkToggle').checked));
        fd.append('generateAudio', String($('vidAudioToggle').checked));
        // Only send the parameters this subtask accepts — a stray key fails the whole
        // request upstream rather than being ignored.
        if (sub !== 'edit') fd.append('duration', $('vidDurationInput').value);
        if (sub === 'reference') fd.append('ratio', $('vidRatioSelect').value);

        if (frames) {
            fd.append('firstFrame', firstFrameSlot.file);
            if (lastFrameSlot.file) fd.append('lastFrame', lastFrameSlot.file);
        } else {
            if (videoFile) fd.append('video', videoFile);
            else if (urlInput.value.trim()) fd.append('refVideoUrl', urlInput.value.trim());
            if (refImageSlot.file) fd.append('image', refImageSlot.file);
        }

        generateBtn.disabled = true;
        const card = makeCard('pending', userMessage);
        processingPool.prepend(card);

        try {
            const r = await fetch('/api/video/generate', { method: 'POST', body: fd });
            const data = await r.json();
            if (!r.ok || !data.success) {
                const msg = typeof data.error === 'string' ? data.error : 'Failed to start.';
                cardError(card, msg);              // full message, sticky + logged
                showToast('Start failed — see card/console for details.', 'error');
                return;
            }
            card.dataset.taskId = data.taskId;
            // Insert the pending record into the gallery list and start polling.
            items.unshift(data.record);
            pending.add(data.taskId);
            renderGallery();
            pollTask(data.taskId, card);
        } catch (e) {
            cardError(card, 'Network error: ' + (e && e.stack ? e.stack : e && e.message ? e.message : String(e)));
            showToast('Network error — see card/console.', 'error');
        } finally {
            generateBtn.disabled = false;
        }
    }
    generateBtn.addEventListener('click', generate);

    // ---------- Polling ----------
    async function pollTask(taskId, card) {
        cardSetStatus(card, 'generating…');
        let attempts = 0;
        const tick = async () => {
            attempts++;
            try {
                const r = await fetch(`/api/video/tasks/${encodeURIComponent(taskId)}`);
                const data = await r.json();
                if (!r.ok || !data.success) {
                    cardError(card, data.error || 'Polling failed.', { taskId });
                    pending.delete(taskId);
                    syncLocalRecord(taskId, { status: 'failed' });
                    renderGallery();
                    return;
                }
                const status = (data.status || (data.task && data.task.status) || 'queued');
                if (status === 'succeeded') {
                    pending.delete(taskId);
                    card.remove();
                    if (data.record) { updateLocalRecord(taskId, data.record); }
                    renderGallery();
                    showToast('Video edit ready.', 'success');
                    return;
                }
                if (status === 'failed') {
                    const reason = (data.task && data.task.error)
                        ? (data.task.error.message || data.task.error.code || JSON.stringify(data.task.error))
                        : 'Generation failed upstream.';
                    pending.delete(taskId);
                    cardError(card, reason, { taskId });
                    syncLocalRecord(taskId, { status: 'failed' });
                    renderGallery();
                    return;
                }
                cardSetStatus(card, status === 'running' ? 'rendering…' : (status === 'queued' ? 'queued…' : status));
                // Scale the interval as the task ages (5s → 10s → 20s).
                const delay = attempts < 6 ? 5000 : attempts < 20 ? 10000 : 20000;
                setTimeout(tick, delay);
            } catch (e) {
                // Transient network blips: keep polling a few times before giving up.
                if (attempts < 12) { setTimeout(tick, 10000); return; }
                cardError(card, 'Stopped polling: ' + (e && e.stack ? e.stack : e && e.message ? e.message : String(e)), {});
                pending.delete(taskId);
            }
        };
        tick();
    }

    /** Re-poll any pending task that survived a refresh/reload (idempotent). */
    function resumePending() {
        for (const it of items) {
            if (it.status === 'queued' || it.status === 'running') {
                if (pending.has(it.id)) continue;
                pending.add(it.id);
                const card = makeCard(it.id, it.prompt);
                processingPool.prepend(card);
                pollTask(it.id, card);
            }
        }
    }

    function updateLocalRecord(taskId, rec) {
        const i = items.findIndex(x => x.id === taskId);
        if (i >= 0) items[i] = rec; else items.unshift(rec);
    }
    function syncLocalRecord(taskId, patch) {
        const i = items.findIndex(x => x.id === taskId);
        if (i >= 0) Object.assign(items[i], patch);
    }

    // ---------- Gallery ----------
    async function loadGallery() {
        // Panic mode (default on): withhold the server's stored video history until
        // the user unlocks it. Clips generated this session live in `items` already
        // and keep rendering; we just don't pull the past in.
        if (window.Panic && !window.Panic.isRevealed()) { renderGallery(); return; }
        try {
            const r = await fetch('/api/video/gallery');
            const d = await r.json();
            if (d.success) { items = d.items; renderGallery(); resumePending(); }
        } catch (e) { showToast('Failed to load videos.', 'error'); }
    }

    function renderGallery() {
        galleryCount.textContent = items.length;
        gallery.innerHTML = '';
        if (items.length === 0) { galleryEmpty.classList.remove('hidden'); return; }
        galleryEmpty.classList.add('hidden');
        items.forEach(it => gallery.appendChild(renderCard(it)));
    }

    function posterFor(it) {
        // Prefer the keyframe the finished task reported, then whatever input we
        // still hold — the reference image (edit) or the start frame we sent (flf2v).
        return it.firstFrame || it.refImage || it.inputFirstFrame || '';
    }

    function renderCard(it) {
        const div = document.createElement('div');
        div.className = 'gallery-item gallery-item-video';
        const isPending = it.status !== 'succeeded' && it.status !== 'failed';
        const failed = it.status === 'failed';

        const poster = posterFor(it);
        const media = (isPending || failed) ? `<div class="video-placeholder ${failed ? 'failed' : ''}">
                <span>${failed ? '⚠ failed' : '⏳ ' + (it.status || 'queued')}</span></div>`
            : `<video src="${it.fullVideo || ''}"
                  poster="${poster}" preload="metadata" muted></video>
                  <span class="play-badge">▶</span>
                  ${it.generateAudio ? '' : '<span class="mute-badge" title="Generated without audio">🔇</span>'}`;
        // On a failed task, surface the upstream reason (if we captured one) under
        // the prompt so the error code stays visible on the gallery card itself.
        const failNote = (failed && it.error)
            ? `<div class="prompt-line" style="color:var(--danger);margin-top:4px;font-size:11px">${escapeHtml(truncate(it.error, 160))}</div>`
            : '';
        div.innerHTML = `${media}<div class="overlay"><div class="prompt-line">${escapeHtml(truncate(it.prompt, 80))}</div>${failNote}</div>`;
        if (!isPending && !failed) div.addEventListener('click', () => openLightbox(it));
        return div;
    }

    refreshBtn.addEventListener('click', loadGallery);

    // ---------- Lightbox ----------
    let current = null;
    // Two-key delete: Del (or the trash button) arms it; the next Enter confirms. See armDelete().
    let deleteArmed = false;
    let deleteArmTimer;
    function openLightbox(it) {
        disarmDelete(); // a delete armed on the previous clip must not carry over
        current = it;
        const src = it.fullVideo || '';
        player.src = src;
        const isFrames = it.taskType === 'first_last';
        const isEdit = it.taskType === 'edit';
        lbTitle.textContent = isEdit ? 'Edit details' : 'Video details';
        lbPromptLabel.textContent = isEdit ? 'Instruction' : 'Prompt';
        lbMode.textContent = isFrames
            ? (it.inputLastFrame ? 'First → last frame' : 'First frame')
            : (isEdit ? 'Reference edit' : 'Reference image');
        lbPrompt.textContent = it.prompt;
        lbModel.textContent = it.model || '—';
        // Ratio is always learned from the finished task — neither mode chooses it.
        lbRatio.textContent = it.videoRatio || '—';
        lbResolution.textContent = it.videoResolution || '—';
        lbCreated.textContent = new Date(it.createdAt).toLocaleString();
        const dur = it.duration != null ? it.duration : it.requestedDuration;
        lbDuration.textContent = dur != null ? `${dur}s` : '—';
        // A clip generated with audio off has no audio track at all, so no player can
        // make sound from it. Say so here rather than letting it look like a mute bug.
        lbAudio.textContent = it.generateAudio ? 'On' : 'Off — no audio track';
        // Nothing to unmute on a clip that was generated silent.
        soundBtn.classList.toggle('hidden', !it.generateAudio);

        lbFrames.classList.toggle('hidden', !it.inputFirstFrame);
        if (it.inputFirstFrame) {
            lbFirstImg.src = it.inputFirstFrame;
            lbLastFig.classList.toggle('hidden', !it.inputLastFrame);
            if (it.inputLastFrame) lbLastImg.src = it.inputLastFrame;
        }

        lbDownload.href = src;
        lbDownload.download = `seedance-${isFrames ? 'video' : 'edit'}-${it.id}.mp4`;
        lightbox.classList.remove('hidden');
        mediaNav.refresh();
        // Open with sound. The element is reused for every clip, so a leftover mute or
        // a volume the browser dropped to 0 would otherwise carry over silently.
        player.muted = false;
        player.volume = 1;
        syncSound();
        player.play().catch(() => {
            // Autoplay with sound was refused. Leave the clip paused with its controls
            // rather than falling back to a muted autoplay — the user's own press on
            // play counts as the gesture, and the audio comes with it.
        });
    }

    // The native chrome is the browser's; this mirrors the real state so a player the
    // browser muted on its own is visible and fixable in one click, in either view.
    function syncSound() {
        const off = player.muted || player.volume === 0;
        soundBtn.textContent = off ? '🔇' : '🔊';
        soundBtn.title = off ? 'Sound off — click to unmute' : 'Sound on — click to mute';
    }
    soundBtn.addEventListener('click', () => {
        if (player.muted || player.volume === 0) {
            player.muted = false;
            if (!player.volume) player.volume = 1;
        } else {
            player.muted = true;
        }
        syncSound();
    });
    player.addEventListener('volumechange', syncSound);
    function closeLightbox() {
        disarmDelete();
        lightbox.classList.add('hidden');
        player.pause(); player.removeAttribute('src'); player.load();
        current = null;
    }
    lbClose.addEventListener('click', closeLightbox);
    lightbox.querySelector('.lightbox-backdrop').addEventListener('click', closeLightbox);
    window.addEventListener('keydown', (e) => {
        if (e.key !== 'Escape' || lightbox.classList.contains('hidden')) return;
        // While a delete is armed, Esc cancels it rather than closing the lightbox.
        if (deleteArmed) { disarmDelete(); showToast('Delete cancelled.', ''); return; }
        closeLightbox();
    });

    // Keyboard shortcuts while the lightbox is open:
    //   Del   → arm deletion (shows a toast; nothing is removed yet)
    //   Enter → confirm a pending deletion, otherwise download the current clip (full MP4)
    // The pending-delete check runs before the download branch so Del → Enter always
    // completes, whatever control happens to be focused.
    window.addEventListener('keydown', (e) => {
        if (lightbox.classList.contains('hidden')) return;
        if (e.key === 'Delete') { e.preventDefault(); armDelete(); return; }
        if (e.key !== 'Enter' || e.ctrlKey || e.metaKey || e.altKey) return;
        if (deleteArmed) { e.preventDefault(); performDelete(); return; }
        const t = e.target;
        if (t && ['BUTTON', 'A', 'INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName)) return;
        e.preventDefault();
        lbDownload.click();
    });

    // Only succeeded items open a lightbox, so prev/next steps over the pending and
    // failed cards rather than landing on a card with nothing to play.
    const mediaNav = MediaNav.attach({
        lightbox,
        list: () => items.filter(it => it.status === 'succeeded'),
        current: () => current,
        open: openLightbox,
        video: true
    });

    // Deletion is a two-key confirmation: Del (or the trash button) arms it and shows a
    // toast; the next Enter carries it out. Nothing blocks on a modal, and the armed state
    // self-clears on timeout so a forgotten confirmation can't linger.
    function armDelete() {
        if (!current) return;
        deleteArmed = true;
        lbDelete.blur(); // drop focus so the confirming Enter reaches the shortcut, not this button
        showToast('Press Enter to confirm delete · Esc to cancel', 'error');
        clearTimeout(deleteArmTimer);
        deleteArmTimer = setTimeout(() => { deleteArmed = false; }, 3500);
    }
    function disarmDelete() {
        deleteArmed = false;
        clearTimeout(deleteArmTimer);
    }
    async function performDelete() {
        if (!current) { disarmDelete(); return; }
        disarmDelete();
        const id = current.id;
        try {
            const r = await fetch(`/api/video/${encodeURIComponent(id)}`, { method: 'DELETE' });
            const d = await r.json();
            if (!d.success) throw new Error(d.error);
            // Only succeeded clips are viewable, so land on a neighbour within that list.
            const viewable = items.filter(it => it.status === 'succeeded');
            const idx = viewable.findIndex(x => x.id === id);
            items = items.filter(i => i.id !== id);
            renderGallery();
            // Keep the viewer open on the adjacent previous clip (the one to the left).
            // Deleting the first falls back to the new first; an emptied list closes.
            const remaining = items.filter(it => it.status === 'succeeded');
            if (remaining.length === 0) closeLightbox();
            else openLightbox(remaining[Math.max(0, idx - 1)]);
            showToast('Deleted.', 'success');
        } catch (e) { showToast('Delete failed: ' + e.message, 'error'); }
    }
    lbDelete.addEventListener('click', armDelete);

    // ---------- Helpers ----------
    function escapeHtml(s) {
        return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    }
    function truncate(s, n) { return s.length <= n ? s : s.slice(0, n - 1) + '…'; }

    // ---------- Public API for app.js ----------
    let loaded = false;
    function ensureLoaded() {
        if (loaded) return;
        loaded = true;
        loadGallery();
    }
    // When panic is lifted, refresh the full history — but only if this tab has
    // already loaded once. If it hasn't, ensureLoaded() will pull the full set the
    // first time the video tab is opened (panic is revealed by then).
    window.Panic?.onReveal(() => { if (loaded) loadGallery(); });
    window.VideoUI = {
        generate,
        onShow() { ensureLoaded(); },
        onAvailability(v) {
            // When the tab/keys come online, load the gallery once so stuck
            // pending tasks resume polling.
            if (v) ensureLoaded();
        },
        onUploadsAvailability(v) {
            uploadsEnabled = !!v;
            uploadNotice?.classList.toggle('hidden', uploadsEnabled);
            [dropZone, imgDropZone, firstDropZone, lastDropZone]
                .forEach(z => z.classList.toggle('disabled', !uploadsEnabled));
        }
    };
})();
