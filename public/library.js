// ============ Prompt Library Drawer ============
(function () {
    const $ = (id) => document.getElementById(id);

    const drawer = $('libraryDrawer');
    const drawerBackdrop = drawer.querySelector('.drawer-backdrop');
    const openBtn = $('libraryBtn');
    const closeBtn = $('libCloseBtn');
    const newBtn = $('libNewBtn');
    const list = $('libList');
    const empty = $('libEmpty');
    const search = $('libSearch');

    const editor = $('libEditor');
    const editorBackdrop = editor.querySelector('.lightbox-backdrop');
    const editorClose = $('libEditorClose');
    const editorCancel = $('libCancelBtn');
    const editorTitle = $('libEditorTitle');
    const titleInput = $('libTitleInput');
    const bodyInput = $('libBodyInput');
    const versionRow = $('libVersionRow');
    const versionSelect = $('libVersionSelect');
    const restoreBtn = $('libRestoreBtn');
    const deleteBtn = $('libDeleteBtn');
    const saveBtn = $('libSaveBtn');

    let cache = [];      // summarized list
    let editing = null;  // full item being edited (with versions)

    const showToast = (m, k) => window.Studio?.showToast(m, k);

    // ----- Drawer -----
    function openDrawer() {
        drawer.classList.remove('hidden');
        load();
    }
    function closeDrawer() { drawer.classList.add('hidden'); }
    openBtn.addEventListener('click', openDrawer);
    closeBtn.addEventListener('click', closeDrawer);
    drawerBackdrop.addEventListener('click', closeDrawer);

    async function load() {
        try {
            const r = await fetch('/api/prompts');
            const d = await r.json();
            if (!d.success) throw new Error(d.error);
            cache = d.items;
            render();
        } catch (e) {
            showToast('Failed to load library: ' + e.message, 'error');
        }
    }

    function render() {
        const q = (search.value || '').trim().toLowerCase();
        const items = q
            ? cache.filter(it => it.title.toLowerCase().includes(q) || it.body.toLowerCase().includes(q))
            : cache;

        list.innerHTML = '';
        if (cache.length === 0) {
            empty.classList.remove('hidden');
            return;
        }
        empty.classList.add('hidden');
        items.forEach(it => {
            const el = document.createElement('div');
            el.className = 'lib-item';
            el.innerHTML = `
                <div class="lib-item-head">
                    <span class="lib-item-title">${escapeHtml(it.title)}</span>
                    <span class="lib-item-ver">v${it.currentVersion}</span>
                </div>
                <div class="lib-item-body">${escapeHtml(it.body)}</div>
                <div class="lib-item-actions">
                    <button class="ghost-btn" data-act="use">Use</button>
                    <button class="ghost-btn" data-act="edit">Edit</button>
                    <button class="danger-btn" data-act="delete">Delete</button>
                </div>
            `;
            el.querySelector('[data-act="use"]').addEventListener('click', () => useItem(it));
            el.querySelector('[data-act="edit"]').addEventListener('click', () => openEditor(it.id));
            el.querySelector('[data-act="delete"]').addEventListener('click', () => deleteItem(it));
            list.appendChild(el);
        });
    }

    search.addEventListener('input', render);

    function useItem(it) {
        window.Studio?.loadTemplate(it);
        showToast(`Loaded "${it.title}".`, 'success');
        closeDrawer();
    }

    async function deleteItem(it) {
        if (!confirm(`Delete "${it.title}" and all its versions?`)) return;
        try {
            const r = await fetch(`/api/prompts/${it.id}`, { method: 'DELETE' });
            const d = await r.json();
            if (!d.success) throw new Error(d.error);
            cache = cache.filter(x => x.id !== it.id);
            render();
            showToast('Deleted.', 'success');
            // Detach if active
            const active = window.Studio?.getActivePrompt();
            if (active && active.id === it.id) window.Studio?.loadTemplate({ id: null, title: '', body: '', currentVersion: 0 });
        } catch (e) {
            showToast('Delete failed: ' + e.message, 'error');
        }
    }

    // ----- Editor -----
    newBtn.addEventListener('click', () => openEditor(null));
    editorClose.addEventListener('click', closeEditor);
    editorBackdrop.addEventListener('click', closeEditor);
    editorCancel.addEventListener('click', closeEditor);

    function closeEditor() { editor.classList.add('hidden'); editing = null; }

    async function openEditor(id) {
        if (id) {
            try {
                const r = await fetch(`/api/prompts/${id}`);
                const d = await r.json();
                if (!d.success) throw new Error(d.error);
                editing = d.item;
                editorTitle.textContent = 'Edit prompt';
                titleInput.value = editing.title;
                const cur = editing.versions.find(v => v.version === editing.currentVersion);
                bodyInput.value = cur ? cur.body : '';
                renderVersionSelect();
                versionRow.classList.remove('hidden');
                deleteBtn.classList.remove('hidden');
            } catch (e) {
                showToast('Load failed: ' + e.message, 'error');
                return;
            }
        } else {
            editing = null;
            editorTitle.textContent = 'New prompt';
            titleInput.value = '';
            bodyInput.value = '';
            versionRow.classList.add('hidden');
            deleteBtn.classList.add('hidden');
        }
        editor.classList.remove('hidden');
        titleInput.focus();
    }

    function renderVersionSelect() {
        if (!editing) return;
        versionSelect.innerHTML = '';
        editing.versions
            .slice()
            .sort((a, b) => b.version - a.version)
            .forEach(v => {
                const opt = document.createElement('option');
                const isCur = v.version === editing.currentVersion;
                const tag = v.restoredFrom ? ` (from v${v.restoredFrom})` : '';
                opt.value = v.version;
                opt.textContent = `v${v.version}${isCur ? ' · current' : ''}${tag} — ${new Date(v.createdAt).toLocaleString()}`;
                versionSelect.appendChild(opt);
            });
        versionSelect.value = editing.currentVersion;
    }

    versionSelect.addEventListener('change', () => {
        if (!editing) return;
        const v = editing.versions.find(x => x.version === parseInt(versionSelect.value, 10));
        if (v) bodyInput.value = v.body;
    });

    restoreBtn.addEventListener('click', async () => {
        if (!editing) return;
        const ver = parseInt(versionSelect.value, 10);
        if (ver === editing.currentVersion) {
            showToast('That is already the current version.', 'error');
            return;
        }
        try {
            const r = await fetch(`/api/prompts/${editing.id}/restore/${ver}`, { method: 'POST' });
            const d = await r.json();
            if (!d.success) throw new Error(d.error);
            // Reload full item
            const r2 = await fetch(`/api/prompts/${editing.id}`);
            const d2 = await r2.json();
            editing = d2.item;
            const cur = editing.versions.find(v => v.version === editing.currentVersion);
            bodyInput.value = cur ? cur.body : '';
            renderVersionSelect();
            showToast(`Restored as v${editing.currentVersion}.`, 'success');
            load();
        } catch (e) {
            showToast('Restore failed: ' + e.message, 'error');
        }
    });

    saveBtn.addEventListener('click', async () => {
        const title = titleInput.value.trim();
        const body = bodyInput.value;
        if (!title) { showToast('Title required.', 'error'); titleInput.focus(); return; }
        if (!body.trim()) { showToast('Body required.', 'error'); bodyInput.focus(); return; }

        try {
            let res;
            if (editing) {
                res = await fetch(`/api/prompts/${editing.id}`, {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ title, body })
                });
            } else {
                res = await fetch('/api/prompts', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ title, body })
                });
            }
            const d = await res.json();
            if (!d.success) throw new Error(d.error);
            showToast(editing ? `Updated to v${d.item.currentVersion}.` : 'Created.', 'success');
            closeEditor();
            load();
        } catch (e) {
            showToast('Save failed: ' + e.message, 'error');
        }
    });

    deleteBtn.addEventListener('click', async () => {
        if (!editing) return;
        if (!confirm(`Delete "${editing.title}" and all its versions?`)) return;
        try {
            const r = await fetch(`/api/prompts/${editing.id}`, { method: 'DELETE' });
            const d = await r.json();
            if (!d.success) throw new Error(d.error);
            showToast('Deleted.', 'success');
            closeEditor();
            load();
        } catch (e) {
            showToast('Delete failed: ' + e.message, 'error');
        }
    });

    // Esc closes whichever is open (editor first)
    window.addEventListener('keydown', (e) => {
        if (e.key !== 'Escape') return;
        if (!editor.classList.contains('hidden')) { closeEditor(); return; }
        if (!drawer.classList.contains('hidden')) closeDrawer();
    });

    function escapeHtml(s) {
        return String(s).replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
    }

    window.LibraryUI = { refresh: load, open: openDrawer };
})();
