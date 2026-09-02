// ============ Panic mode ============
// Default ON, every page load. While panic is on, generation history from before
// this session stays hidden — both galleries start empty and report 0 records.
// Anything generated during the session still shows (those items live in each
// tab's in-memory list, not the server history we withhold).
//
// The only way out is a deliberate secret gesture: five clicks on the brand-mark
// (the little gradient square left of the "BytePlus Studio" title). Reveal is
// in-memory only — a reload or a fresh tab re-arms panic, which is what "default
// on" means here. Nothing is persisted to storage on purpose.
(function () {
    let revealed = false;
    const callbacks = [];

    // Clicks must come in a burst; a pause longer than the window resets the count
    // so a stray tap on the logo can't slowly accumulate into a reveal.
    const RESET_MS = 2000;
    const NEEDED = 5;
    let clicks = 0;
    let resetTimer = null;

    function reveal() {
        if (revealed) return;
        revealed = true;
        callbacks.forEach(cb => { try { cb(); } catch (_) { /* isolate one bad handler */ } });
        window.Studio?.showToast?.('Past history unlocked.', 'success');
    }

    const brand = document.querySelector('.brand-mark');
    if (brand) {
        brand.addEventListener('click', () => {
            if (revealed) return;
            clicks++;
            clearTimeout(resetTimer);
            if (clicks >= NEEDED) {
                clicks = 0;
                reveal();
                return;
            }
            resetTimer = setTimeout(() => { clicks = 0; }, RESET_MS);
        });
    }

    window.Panic = {
        // False until the gesture unlocks; each gallery checks this before pulling
        // the server's stored history.
        isRevealed: () => revealed,
        // Run cb now if already revealed, otherwise once the gesture fires. Galleries
        // use this to (re)load their full history at the moment of reveal.
        onReveal(cb) { if (revealed) cb(); else callbacks.push(cb); }
    };
})();
