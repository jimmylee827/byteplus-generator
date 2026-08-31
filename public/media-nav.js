// ============ Shared lightbox media navigation ============
// Both lightboxes get the same treatment: prev/next stepping through whatever the
// gallery is currently showing, and a click on the media itself for a full-bleed
// view whose left and right thirds are invisible nav targets.
//
// The two lightboxes keep their own open/close/meta logic — this only borrows a
// list, a "which one is open" getter, and the open function, so the image tab can
// walk its search-filtered order and the video tab can skip pending/failed items.
(function () {
    // Native <video> chrome lives inside the element, so clicks on the scrubber land
    // on the <video> just like clicks on the picture do. Leave the bottom strip alone.
    const CONTROLS_STRIP = 60;

    function attach({ lightbox, list, current, open, video }) {
        const wrap = lightbox.querySelector('.lightbox-image-wrap');
        wrap.insertAdjacentHTML('beforeend', `
            <button class="lb-nav lb-nav-prev" type="button" aria-label="Previous">‹</button>
            <button class="lb-nav lb-nav-next" type="button" aria-label="Next">›</button>
            <div class="lb-zones">
                <div class="lb-zone lb-zone-prev" title="Previous"></div>
                <div class="lb-zone lb-zone-exit" title="Exit full screen"></div>
                <div class="lb-zone lb-zone-next" title="Next"></div>
            </div>
        `);
        const prevBtn = wrap.querySelector('.lb-nav-prev');
        const nextBtn = wrap.querySelector('.lb-nav-next');

        function indexOf() {
            const cur = current();
            if (!cur) return -1;
            return list().findIndex(x => x.id === cur.id);
        }

        function step(delta) {
            const i = indexOf();
            if (i < 0) return;
            const next = list()[i + delta];
            if (next) open(next);
        }

        // Called by each tab at the end of its own openLightbox, once the item is current.
        function refresh() {
            const arr = list();
            const i = indexOf();
            prevBtn.classList.toggle('hidden', i <= 0);
            nextBtn.classList.toggle('hidden', i < 0 || i >= arr.length - 1);
        }

        const isFull = () => lightbox.classList.contains('lb-full');
        function setFull(on) { lightbox.classList.toggle('lb-full', on); }

        function bind(el, fn) {
            el.addEventListener('click', (e) => { e.stopPropagation(); fn(); });
        }
        bind(prevBtn, () => step(-1));
        bind(nextBtn, () => step(1));
        bind(wrap.querySelector('.lb-zone-prev'), () => step(-1));
        bind(wrap.querySelector('.lb-zone-next'), () => step(1));
        bind(wrap.querySelector('.lb-zone-exit'), () => setFull(false));

        wrap.addEventListener('click', (e) => {
            if (isFull()) return;
            const el = e.target;
            if (el !== wrap && el.tagName !== 'IMG' && el.tagName !== 'VIDEO') return;
            if (video && el.tagName === 'VIDEO'
                && e.clientY > el.getBoundingClientRect().bottom - CONTROLS_STRIP) return;
            setFull(true);
        });

        // Capture phase, so Escape reaches us before each tab's own window handler:
        // the first press backs out of full-bleed, the next one closes the lightbox.
        window.addEventListener('keydown', (e) => {
            if (lightbox.classList.contains('hidden')) return;
            if (e.key === 'ArrowLeft') { e.preventDefault(); step(-1); }
            else if (e.key === 'ArrowRight') { e.preventDefault(); step(1); }
            else if (e.key === 'Escape' && isFull()) { e.stopPropagation(); setFull(false); }
        }, true);

        // Closing resets the view, so reopening never lands in a leftover full-bleed.
        new MutationObserver(() => {
            if (isFull() && lightbox.classList.contains('hidden')) setFull(false);
        }).observe(lightbox, { attributes: true, attributeFilter: ['class'] });

        return { refresh };
    }

    window.MediaNav = { attach };
})();
