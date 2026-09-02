// ============ Constants ============
// Per-model image configuration. The "endpoint" model resolves to the Seedream
// endpoint ID configured on the server (.env ENDPOINT_ID); every other entry is a
// ModelArk model ID forwarded verbatim. Resolutions and exact pixel dimensions
// differ between models (e.g. 5.0 Pro tops out at 2K, 4.5 reaches 4K), so the
// matrix is keyed per model.
const SEEDREAM_MODELS = {
    endpoint: {
        label: 'Seedream 4.5 (endpoint)',
        resolutions: ['2K', '4K'],
        defaultResolution: '4K',
        // outputFormat null → let the endpoint default (jpeg)
        outputFormat: null,
        matrix: {
            '2K': {
                '1:1': '2048x2048', '4:3': '2304x1728', '3:4': '1728x2304',
                '16:9': '2848x1600', '9:16': '1600x2848', '3:2': '2496x1664',
                '2:3': '1664x2496', '21:9': '3136x1344'
            },
            '4K': {
                '1:1': '4096x4096', '4:3': '4704x3520', '3:4': '3520x4704',
                '16:9': '5504x3040', '9:16': '3040x5504', '3:2': '4992x3328',
                '2:3': '3328x4992', '21:9': '6240x2656'
            }
        }
    },
    'dola-seedream-5-0-pro-260628': {
        label: 'Seedream 5.0 Pro',
        resolutions: ['1K', '1.5K', '2K'],
        defaultResolution: '2K',
        // 5.0 Pro supports png & jpeg; pin jpeg so gallery files stay consistent.
        outputFormat: 'jpeg',
        matrix: {
            '1K': {
                '1:1': '1024x1024', '4:3': '1152x864', '3:4': '864x1152',
                '16:9': '1424x800', '9:16': '800x1424', '3:2': '1248x832',
                '2:3': '832x1248', '21:9': '1568x672'
            },
            '1.5K': {
                '1:1': '1536x1536', '4:3': '1792x1344', '3:4': '1344x1792',
                '16:9': '2048x1152', '9:16': '1152x2048', '3:2': '1872x1248',
                '2:3': '1248x1872', '21:9': '2352x1008'
            },
            '2K': {
                '1:1': '2048x2048', '4:3': '2368x1776', '3:4': '1776x2368',
                '16:9': '2816x1584', '9:16': '1584x2816', '3:2': '2496x1664',
                '2:3': '1664x2496', '21:9': '3136x1344'
            }
        }
    }
};

// ============ State ============
const state = {
    inputFiles: [],   // File[]
    gallery: [],      // manifest items
    searchTerm: '',
    slotValues: {},   // { name: currentValue }
    slotDefaults: {}, // { name: defaultValue }
    activePrompt: null, // { id, title, currentVersion } when editing a saved prompt
    videoEnabled: false,
    videoUploadsEnabled: false
};

// ============ DOM refs ============
const $ = (id) => document.getElementById(id);
const dropZone = $('dropZone');
const fileInput = $('fileInput');
const browseBtn = $('browseBtn');
const thumbStrip = $('thumbStrip');
const promptInput = $('promptInput');
const resolutionSelect = $('resolutionSelect');
const ratioSelect = $('ratioSelect');
const watermarkToggle = $('watermarkToggle');
const modelSelect = $('modelSelect');
const tabStrip = $('tabStrip');
const generateBtn = $('generateBtn');
const processingPool = $('processingPool');
const gallery = $('gallery');
const galleryEmpty = $('galleryEmpty');
const galleryCount = $('galleryCount');
const searchInput = $('searchInput');
const refreshBtn = $('refreshBtn');
const lightbox = $('lightbox');
const lightboxImg = $('lightboxImg');
const lbPrompt = $('lbPrompt');
const lbModel = $('lbModel');
const lbSize = $('lbSize');
const lbRatio = $('lbRatio');
const lbCreated = $('lbCreated');
const lbInputs = $('lbInputs');
const lbCopyPrompt = $('lbCopyPrompt');
const lbDownload = $('lbDownload');
const lbDelete = $('lbDelete');
const lightboxClose = $('lightboxClose');
const statusPill = $('statusPill');
const statusText = $('statusText');
const toast = $('toast');
const slotsRow = $('slotsRow');
const slotsList = $('slotsList');
const slotsHint = $('slotsHint');
const compiledPreview = $('compiledPreview');
const resetSlotsBtn = $('resetSlotsBtn');
const saveToLibBtn = $('saveToLibBtn');
const activePromptBadge = $('activePromptBadge');
const activePromptTitle = $('activePromptTitle');
const activePromptVer = $('activePromptVer');
const detachPromptBtn = $('detachPromptBtn');

// Remembers which files were saved this page load so a repeat activation (a double
// click, or the Enter shortcut landing on an already-saved image) is blocked with a
// toast instead of re-triggering the browser download. In-memory only: cleared on reload.
const downloadedImages = new Set();
function activateImageDownload(event) {
    disarmDelete(); // choosing to download is a different intent — cancel any pending delete
    const href = lbDownload.href;
    if (!href) { event.preventDefault(); return; }
    if (downloadedImages.has(href)) {
        event.preventDefault();
        showToast('Already downloaded.', '');
        return;
    }
    downloadedImages.add(href);
}
lbDownload.addEventListener('click', activateImageDownload);

// ============ Toast ============
let toastTimer;
function showToast(msg, kind = '') {
    toast.textContent = msg;
    toast.className = `toast show ${kind}`;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toast.classList.remove('show'), 3500);
}

// ============ Health ============
async function checkHealth() {
    try {
        const r = await fetch('/api/health');
        const d = await r.json();
        if (d.ok) {
            statusPill.classList.add('ok');
            statusPill.classList.remove('err');
            statusText.textContent = `${d.activeKeys}/${d.totalKeys} keys`;
            state.videoEnabled = !!d.videoEnabled;
            state.videoUploadsEnabled = !!d.videoUploadsEnabled;
            updateVideoTab();
        } else throw new Error('not ok');
    } catch {
        statusPill.classList.add('err');
        statusText.textContent = 'offline';
        state.videoEnabled = false;
        state.videoUploadsEnabled = false;
        updateVideoTab();
    }
}

// Reflect video availability on the tab + notice.
function updateVideoTab() {
    const tab = $('videoTab');
    const notice = $('vidDisabledNotice');
    const view = $('videoView');
    if (state.videoEnabled) {
        tab.classList.remove('disabled');
        tab.disabled = false;
        notice.classList.add('hidden');
    } else {
        tab.classList.add('disabled');
        tab.disabled = false; // still clickable so the user can see the notice
        if (!view.classList.contains('hidden')) notice.classList.remove('hidden');
    }
    if (window.VideoUI?.onAvailability) window.VideoUI.onAvailability(state.videoEnabled);
    if (window.VideoUI?.onUploadsAvailability) window.VideoUI.onUploadsAvailability(state.videoUploadsEnabled);
}

// ============ Tab switching ============
function switchTab(name) {
    const image = $('imageView');
    const video = $('videoView');
    [...tabStrip.children].forEach(b => b.classList.toggle('active', b.dataset.tab === name));
    if (name === 'video') {
        image.classList.add('hidden');
        video.classList.remove('hidden');
        $('vidDisabledNotice').classList.toggle('hidden', state.videoEnabled);
        window.VideoUI?.onShow?.();
    } else {
        image.classList.remove('hidden');
        video.classList.add('hidden');
    }
}
tabStrip.addEventListener('click', (e) => {
    const btn = e.target.closest('.tab');
    if (btn && !btn.classList.contains('active')) switchTab(btn.dataset.tab);
});

// ============ File handling ============
function addFiles(fileList) {
    const incoming = Array.from(fileList).filter(f => f.type.startsWith('image/'));
    const room = 9 - state.inputFiles.length;
    if (room <= 0) {
        showToast('Maximum 9 images.', 'error');
        return;
    }
    const accepted = incoming.slice(0, room);
    const rejected = incoming.length - accepted.length;
    state.inputFiles.push(...accepted);
    if (rejected > 0) showToast(`Added ${accepted.length}, dropped ${rejected} (max 9).`, 'error');
    renderThumbs();
}

function removeFile(idx) {
    state.inputFiles.splice(idx, 1);
    renderThumbs();
}

function renderThumbs() {
    thumbStrip.innerHTML = '';
    state.inputFiles.forEach((file, idx) => {
        const div = document.createElement('div');
        div.className = 'thumb';
        const img = document.createElement('img');
        img.src = URL.createObjectURL(file);
        img.onload = () => URL.revokeObjectURL(img.src);
        const btn = document.createElement('button');
        btn.className = 'remove';
        btn.textContent = '×';
        btn.title = 'Remove';
        btn.addEventListener('click', (e) => { e.stopPropagation(); removeFile(idx); });
        div.append(img, btn);
        thumbStrip.appendChild(div);
    });
}

// Drag & drop
['dragenter', 'dragover'].forEach(ev => {
    dropZone.addEventListener(ev, (e) => {
        e.preventDefault(); e.stopPropagation();
        dropZone.classList.add('drag-over');
    });
});
['dragleave', 'drop'].forEach(ev => {
    dropZone.addEventListener(ev, (e) => {
        e.preventDefault(); e.stopPropagation();
        dropZone.classList.remove('drag-over');
    });
});
dropZone.addEventListener('drop', (e) => {
    if (e.dataTransfer?.files?.length) addFiles(e.dataTransfer.files);
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
    if (fileInput.files?.length) addFiles(fileInput.files);
    fileInput.value = '';
});

// Paste from clipboard
window.addEventListener('paste', (e) => {
    const files = Array.from(e.clipboardData?.files || []).filter(f => f.type.startsWith('image/'));
    if (files.length) {
        addFiles(files);
        showToast(`Pasted ${files.length} image${files.length > 1 ? 's' : ''}.`, 'success');
    }
});

// ============ Generation ============
function currentModelKey() { return modelSelect.value || 'endpoint'; }
function currentModelCfg() { return SEEDREAM_MODELS[currentModelKey()] || SEEDREAM_MODELS.endpoint; }

// Populate the resolution dropdown for the selected model, preserving the current
// choice when it is still valid and falling back to the model default otherwise.
function syncResolutionOptions() {
    const cfg = currentModelCfg();
    const prev = resolutionSelect.value;
    resolutionSelect.innerHTML = '';
    cfg.resolutions.forEach(r => {
        const opt = document.createElement('option');
        opt.value = r; opt.textContent = r;
        resolutionSelect.appendChild(opt);
    });
    resolutionSelect.value = cfg.resolutions.includes(prev) ? prev : cfg.defaultResolution;
}

function populateModels() {
    modelSelect.innerHTML = '';
    Object.entries(SEEDREAM_MODELS).forEach(([key, cfg]) => {
        const opt = document.createElement('option');
        opt.value = key; opt.textContent = cfg.label;
        modelSelect.appendChild(opt);
    });
    // Default to the configured endpoint (keeps existing behaviour).
    modelSelect.value = 'endpoint';
    syncResolutionOptions();
}
modelSelect.addEventListener('change', syncResolutionOptions);

function buildSize() {
    const cfg = currentModelCfg();
    const res = resolutionSelect.value;
    const ratio = ratioSelect.value;
    if (ratio === 'auto') return res;
    return cfg.matrix[res]?.[ratio] || res;
}

function makeJobCard(jobId, prompt) {
    const card = document.createElement('div');
    card.className = 'job-card';
    card.dataset.jobId = jobId;
    card.innerHTML = `
        <div class="skeleton"></div>
        <div class="job-meta">
            <span class="spinner"></span>
            <span class="prompt-preview">${escapeHtml(truncate(prompt, 60))}</span>
        </div>
    `;
    return card;
}

function jobCardError(card, msg) {
    card.classList.add('error');
    card.querySelector('.skeleton').textContent = msg;
    card.querySelector('.spinner').remove();
    card.querySelector('.job-meta').insertAdjacentHTML('afterbegin', '<span style="color:var(--danger)">⚠</span> ');
    setTimeout(() => card.remove(), 6000);
}

async function generate() {
    const rawPrompt = promptInput.value.trim();
    if (!rawPrompt) {
        showToast('Please enter a prompt.', 'error');
        promptInput.focus();
        return;
    }
    const prompt = compilePrompt(rawPrompt);

    const jobId = crypto.randomUUID();
    const card = makeJobCard(jobId, prompt);
    processingPool.prepend(card);

    const fd = new FormData();
    fd.append('prompt', prompt);
    fd.append('model', currentModelKey());
    fd.append('size', buildSize());
    const outFmt = currentModelCfg().outputFormat;
    if (outFmt) fd.append('output_format', outFmt);
    fd.append('watermark', String(watermarkToggle.checked));
    state.inputFiles.forEach(f => fd.append('images', f));

    try {
        const r = await fetch('/api/generate', { method: 'POST', body: fd });
        const data = await r.json();
        if (!r.ok || !data.success) {
            const msg = typeof data.error === 'string' ? data.error : JSON.stringify(data.error || 'Unknown error');
            jobCardError(card, truncate(msg, 140));
            showToast('Generation failed: ' + truncate(msg, 80), 'error');
            return;
        }
        // Insert into gallery and remove job card
        state.gallery.unshift(data.item);
        renderGallery();
        card.remove();
        showToast('Image generated.', 'success');
    } catch (e) {
        jobCardError(card, 'Network error: ' + e.message);
        showToast('Network error.', 'error');
    }
}

generateBtn.addEventListener('click', generate);
promptInput.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') generate();
});
// Allow Ctrl/Cmd+Enter from anywhere (e.g., slot textareas) to trigger generate
window.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
        const t = e.target;
        if (t && (t.tagName === 'TEXTAREA' || t.tagName === 'INPUT') && t !== promptInput) {
            e.preventDefault();
            if (!$('videoView').classList.contains('hidden')) {
                window.VideoUI?.generate();
            } else {
                generate();
            }
        }
    }
});

// ============ Gallery ============
async function loadGallery() {
    // Panic mode (default on): withhold the server's stored history until the user
    // unlocks it with the brand-mark gesture. Session-generated images already live
    // in state.gallery and keep rendering; we simply don't pull the past in.
    if (window.Panic && !window.Panic.isRevealed()) {
        renderGallery();
        return;
    }
    try {
        const r = await fetch('/api/gallery');
        const d = await r.json();
        if (d.success) {
            state.gallery = d.items;
            renderGallery();
        }
    } catch (e) {
        showToast('Failed to load gallery.', 'error');
    }
}

function filteredGallery() {
    const q = state.searchTerm.toLowerCase().trim();
    if (!q) return state.gallery;
    return state.gallery.filter(it => it.prompt.toLowerCase().includes(q));
}

function renderGallery() {
    const items = filteredGallery();
    galleryCount.textContent = state.gallery.length;
    gallery.innerHTML = '';
    if (state.gallery.length === 0) {
        galleryEmpty.classList.remove('hidden');
        return;
    }
    galleryEmpty.classList.add('hidden');
    items.forEach(item => {
        const div = document.createElement('div');
        div.className = 'gallery-item';
        div.innerHTML = `
            <img src="${item.outputPath}" loading="lazy" alt="">
            <div class="overlay"><div class="prompt-line">${escapeHtml(item.prompt)}</div></div>
        `;
        div.addEventListener('click', () => openLightbox(item));
        gallery.appendChild(div);
    });
}

searchInput.addEventListener('input', (e) => {
    state.searchTerm = e.target.value;
    renderGallery();
});
refreshBtn.addEventListener('click', loadGallery);

// ============ Lightbox ============
let currentLightboxItem = null;
// Two-key delete: Del (or the trash button) arms it; the next Enter confirms. See armDelete().
let deleteArmed = false;
let deleteArmTimer;
function openLightbox(item) {
    disarmDelete(); // a delete armed on the previous item must not carry over
    currentLightboxItem = item;
    lightboxImg.src = item.outputPath;
    lbPrompt.textContent = item.prompt;
    lbModel.textContent = item.model || '—';
    lbSize.textContent = item.size || '—';
    lbRatio.textContent = item.requestedSize || '—';
    lbCreated.textContent = new Date(item.createdAt).toLocaleString();
    lbDownload.href = item.outputPath;
    lbDownload.download = `seedream-${item.id}.jpeg`;
    if (item.inputThumbs && item.inputThumbs.length) {
        lbInputs.innerHTML = `<div class="input-thumbs">${item.inputThumbs.map(p => `<img src="${p}" alt="">`).join('')}</div>`;
    } else {
        lbInputs.textContent = 'None (text-to-image)';
    }
    lightbox.classList.remove('hidden');
    mediaNav.refresh();
}
function closeLightbox() { disarmDelete(); lightbox.classList.add('hidden'); currentLightboxItem = null; }
lightboxClose.addEventListener('click', closeLightbox);
$('lightbox').querySelector('.lightbox-backdrop').addEventListener('click', closeLightbox);
window.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || lightbox.classList.contains('hidden')) return;
    // While a delete is armed, Esc cancels it rather than closing the lightbox.
    if (deleteArmed) { disarmDelete(); showToast('Delete cancelled.', ''); return; }
    closeLightbox();
});

// Keyboard shortcuts while the lightbox is open:
//   Del   → arm deletion (shows a toast; nothing is removed yet)
//   Enter → confirm a pending deletion, otherwise download the current image (full size)
// The pending-delete check runs before the download branch so Del → Enter always
// completes, whatever control happens to be focused. Enter still mirrors the download
// button (routed through its click) when no delete is armed.
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

// Prev/next walks the filtered gallery, so navigation follows whatever the search
// box is currently showing rather than the unfiltered set behind it.
const mediaNav = MediaNav.attach({
    lightbox,
    list: filteredGallery,
    current: () => currentLightboxItem,
    open: openLightbox
});

lbCopyPrompt.addEventListener('click', async () => {
    if (!currentLightboxItem) return;
    await navigator.clipboard.writeText(currentLightboxItem.prompt);
    showToast('Prompt copied.', 'success');
});

// Deletion is a two-key confirmation: Del (or the trash button) arms it and shows a
// toast; the next Enter carries it out. Nothing blocks on a modal, and the armed state
// self-clears on timeout so a forgotten confirmation can't linger.
function armDelete() {
    if (!currentLightboxItem) return;
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
    if (!currentLightboxItem) { disarmDelete(); return; }
    disarmDelete();
    const id = currentLightboxItem.id;
    try {
        const r = await fetch(`/api/gallery/${id}`, { method: 'DELETE' });
        const d = await r.json();
        if (!d.success) throw new Error(d.error);
        // Note where the deleted image sat so we can land on its neighbour afterwards.
        const idx = filteredGallery().findIndex(x => x.id === id);
        state.gallery = state.gallery.filter(i => i.id !== id);
        renderGallery();
        // Keep the viewer open on the adjacent previous image (the one to the left).
        // Deleting the first image falls back to the new first; an emptied gallery closes.
        const remaining = filteredGallery();
        if (remaining.length === 0) closeLightbox();
        else openLightbox(remaining[Math.max(0, idx - 1)]);
        showToast('Deleted.', 'success');
    } catch (e) {
        showToast('Delete failed: ' + e.message, 'error');
    }
}
lbDelete.addEventListener('click', armDelete);

// ============ Helpers ============
function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
}
function truncate(s, n) { return s.length <= n ? s : s.slice(0, n - 1) + '…'; }

// ============ Slot / Template engine ============
// Syntax: {{name:default}} or {{name}} (default is empty)
// Duplicate names share one input. First occurrence's default is used if defaults differ.
const SLOT_RE = /\{\{\s*([A-Za-z0-9_\-]+)\s*(?::([^}]*))?\}\}/g;

function parseSlots(template) {
    const order = [];
    const defaults = {};
    let m;
    SLOT_RE.lastIndex = 0;
    while ((m = SLOT_RE.exec(template)) !== null) {
        const name = m[1];
        const def = m[2] !== undefined ? m[2] : '';
        if (!(name in defaults)) {
            defaults[name] = def;
            order.push(name);
        }
    }
    return { order, defaults };
}

function compilePrompt(template) {
    return template.replace(SLOT_RE, (_match, name) => {
        // Empty string means "intentionally empty" — only fall back to the default
        // when the user has never touched this slot (value is undefined).
        const v = state.slotValues[name];
        return v !== undefined ? v : (state.slotDefaults[name] || '');
    });
}

function refreshSlots({ resetValues = false } = {}) {
    const template = promptInput.value;
    const { order, defaults } = parseSlots(template);

    if (order.length === 0) {
        slotsRow.classList.add('hidden');
        state.slotValues = {};
        state.slotDefaults = {};
        return;
    }

    state.slotDefaults = defaults;
    if (resetValues) {
        state.slotValues = { ...defaults };
    } else {
        // Keep values for vars that still exist; drop the rest; add new ones from defaults
        const next = {};
        for (const name of order) {
            next[name] = (name in state.slotValues) ? state.slotValues[name] : defaults[name];
        }
        state.slotValues = next;
    }

    renderSlots(order);
    slotsRow.classList.remove('hidden');
    slotsHint.textContent = `(${order.length})`;
    renderCompiledPreview();
}

function renderSlots(order) {
    slotsList.innerHTML = '';
    order.forEach(name => {
        const chip = document.createElement('label');
        chip.className = 'slot-chip';
        const def = state.slotDefaults[name] || '';
        const val = state.slotValues[name] ?? def;
        if (val !== def) chip.classList.add('dirty');
        chip.innerHTML = `<span class="slot-name">${escapeHtml(name)}</span>`;
        const input = document.createElement('textarea');
        input.rows = 1;
        input.value = val;
        input.placeholder = def || '(empty)';
        input.spellcheck = false;
        // Auto-grow vertically; width is 100% via CSS
        const autosize = () => {
            input.style.height = 'auto';
            input.style.height = input.scrollHeight + 'px';
        };
        input.addEventListener('input', () => {
            state.slotValues[name] = input.value;
            autosize();
            chip.classList.toggle('dirty', input.value !== def);
            renderCompiledPreview();
        });
        chip.appendChild(input);

        // Per-chip "restore default" button (only meaningful when a default exists)
        if (def) {
            const restore = document.createElement('button');
            restore.type = 'button';
            restore.className = 'slot-restore';
            restore.title = `Restore default: ${def}`;
            restore.setAttribute('aria-label', `Restore default for ${name}`);
            restore.textContent = '↻';
            restore.addEventListener('click', (e) => {
                e.preventDefault();
                e.stopPropagation();
                input.value = def;
                state.slotValues[name] = def;
                chip.classList.remove('dirty');
                autosize();
                renderCompiledPreview();
                input.focus();
            });
            chip.appendChild(restore);
        }

        slotsList.appendChild(chip);
        // Defer initial sizing until in DOM so scrollHeight is accurate
        requestAnimationFrame(autosize);
    });
}

function renderCompiledPreview() {
    const compiled = compilePrompt(promptInput.value);
    // Highlight filled regions
    const template = promptInput.value;
    let html = '';
    let lastIdx = 0;
    SLOT_RE.lastIndex = 0;
    let m;
    while ((m = SLOT_RE.exec(template)) !== null) {
        html += escapeHtml(template.slice(lastIdx, m.index));
        const name = m[1];
        const v = state.slotValues[name] !== undefined
            ? state.slotValues[name]
            : (state.slotDefaults[name] || '');
        html += `<span class="filled">${escapeHtml(v)}</span>`;
        lastIdx = m.index + m[0].length;
    }
    html += escapeHtml(template.slice(lastIdx));
    compiledPreview.innerHTML = html || '<em class="hint">empty</em>';
    return compiled;
}

promptInput.addEventListener('input', () => refreshSlots());
resetSlotsBtn.addEventListener('click', () => refreshSlots({ resetValues: true }));

// ============ Active prompt + Save to library ============
function setActivePrompt(p) {
    state.activePrompt = p;
    if (p) {
        activePromptBadge.classList.remove('hidden');
        activePromptTitle.textContent = p.title;
        activePromptVer.textContent = `v${p.currentVersion}`;
    } else {
        activePromptBadge.classList.add('hidden');
    }
}
detachPromptBtn.addEventListener('click', () => setActivePrompt(null));

saveToLibBtn.addEventListener('click', async () => {
    const body = promptInput.value.trim();
    if (!body) { showToast('Prompt is empty.', 'error'); return; }

    if (state.activePrompt) {
        // Update existing
        try {
            const r = await fetch(`/api/prompts/${state.activePrompt.id}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ body })
            });
            const d = await r.json();
            if (!d.success) throw new Error(d.error);
            setActivePrompt(d.item);
            showToast(`Saved as v${d.item.currentVersion}.`, 'success');
            window.LibraryUI?.refresh();
        } catch (e) {
            showToast('Save failed: ' + e.message, 'error');
        }
    } else {
        const title = prompt('Title for this prompt:');
        if (!title || !title.trim()) return;
        try {
            const r = await fetch('/api/prompts', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ title: title.trim(), body })
            });
            const d = await r.json();
            if (!d.success) throw new Error(d.error);
            setActivePrompt(d.item);
            showToast('Saved to library.', 'success');
            window.LibraryUI?.refresh();
        } catch (e) {
            showToast('Save failed: ' + e.message, 'error');
        }
    }
});

// Expose API for library.js
window.Studio = {
    loadTemplate(item) {
        // item: { id, title, body, currentVersion }
        promptInput.value = item.body;
        setActivePrompt(item);
        refreshSlots({ resetValues: true });
        promptInput.focus();
    },
    showToast,
    refreshSlots,
    getActivePrompt: () => state.activePrompt,
    getVideoEnabled: () => state.videoEnabled
};

// ============ Init ============
populateModels();
checkHealth();
loadGallery();
// When panic is lifted, pull the full stored history in (this replaces the
// session-only view with everything the server has, session items included).
window.Panic?.onReveal(() => loadGallery());
setInterval(checkHealth, 30000);
