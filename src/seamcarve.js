// Content-aware scaling (seam carving) — pure JavaScript, no dependencies.
//
// Implements forward-energy seam carving (Rubinstein, Shamir & Avidan 2008),
// the same family of algorithm behind Photoshop's Content-Aware Scale:
//   * shrinking removes the lowest-cost connected seams of pixels
//   * enlarging finds the k lowest-cost seams and duplicates them
//   * "amount" blends content-aware with ordinary scaling, like Photoshop's slider
//   * an optional protect mask (0..255 per pixel) keeps important areas intact
//
// Pixels are RGBA8, row-major, no padding (width * height * 4 bytes).

'use strict';

const SeamCarve = (function () {
    const PROTECT_WEIGHT = 1e5; // added cost per protected pixel (scaled by mask/255)

    // ---------- helpers ----------

    function toPacked(rgba, w, h) {
        // View the bytes as one Uint32 per pixel (copy, so the input is untouched).
        const out = new Uint32Array(w * h);
        new Uint8Array(out.buffer).set(rgba.subarray(0, w * h * 4));
        return out;
    }

    function fromPacked(px, w, h) {
        return new Uint8Array(px.buffer, px.byteOffset, w * h * 4).slice();
    }

    function lumaOf(p) {
        // Works on the packed value regardless of endianness of R/B order: we
        // only need a stable brightness-like signal, alpha-weighted so that
        // transparent pixels are cheap to remove.
        const b0 = p & 255, b1 = (p >>> 8) & 255, b2 = (p >>> 16) & 255, a = p >>> 24;
        return (0.299 * b0 + 0.587 * b1 + 0.114 * b2) * (a / 255);
    }

    function transpose(src, w, h, Ctor) {
        const out = new Ctor(w * h);
        for (let y = 0; y < h; y++) {
            const row = y * w;
            for (let x = 0; x < w; x++) out[x * h + y] = src[row + x];
        }
        return out;
    }

    function avgPixel(a, b) {
        // Per-channel average of two packed RGBA pixels.
        return (((((a & 0xff) + (b & 0xff)) >>> 1)) |
                ((((a >>> 8 & 0xff) + (b >>> 8 & 0xff)) >>> 1) << 8) |
                ((((a >>> 16 & 0xff) + (b >>> 16 & 0xff)) >>> 1) << 16) |
                ((((a >>> 24) + (b >>> 24)) >>> 1) << 24)) >>> 0;
    }

    // ---------- core: find one vertical seam (forward energy) ----------
    //
    // Buffers have a fixed row stride `S`; only the first `w` columns are live.
    // Returns seam as Int32Array of x positions (one per row).

    function computeDP(gray, protect, S, w, h, M, back) {
        // Hot loop: runs once per pixel per seam. Edge columns and protection are
        // handled outside the inner loop. Math.abs is kept on purpose: V8 makes
        // it branch-free, whereas `if (d < 0) d = -d` mispredicts on noisy photos.
        // Choice between up-left / up / up-right is the same as the textbook
        // forward-energy formulation (the shared cU term is added once).
        if (protect) for (let x = 0; x < w; x++) M[x] = protect[x] * PROTECT_WEIGHT;
        else M.fill(0, 0, w);

        for (let y = 1; y < h; y++) {
            const r = y * S, rp = r - S;

            if (w === 1) { M[r] = M[rp]; back[r] = 0; }
            else {
                // x = 0: neighbours are (self, x+1); can come from up or up-right.
                {
                    const C = gray[r], R = gray[r + 1], U = gray[rp];
                    const cU = Math.abs(R - C);
                    const dr = Math.abs(U - R);
                    const mU = M[rp], mR = M[rp + 1] + dr;
                    if (mR < mU) { M[r] = mR + cU; back[r] = 1; }
                    else { M[r] = mU + cU; back[r] = 0; }
                }
                // interior
                let L = gray[r], C = gray[r + 1];
                for (let x = 1, e = w - 1; x < e; x++) {
                    const R = gray[r + x + 1], U = gray[rp + x];
                    const cU = Math.abs(R - L);
                    const dl = Math.abs(U - L);
                    const dr = Math.abs(U - R);
                    let best = M[rp + x], dir = 0;
                    const mL = M[rp + x - 1] + dl;
                    if (mL < best) { best = mL; dir = -1; }
                    const mR = M[rp + x + 1] + dr;
                    if (mR < best) { best = mR; dir = 1; }
                    M[r + x] = best + cU;
                    back[r + x] = dir;
                    L = C; C = R;
                }
                // x = w-1: neighbours are (x-1, self); can come from up or up-left.
                {
                    const x = w - 1;
                    const Lv = gray[r + x - 1], C2 = gray[r + x], U = gray[rp + x];
                    const cU = Math.abs(C2 - Lv);
                    const dl = Math.abs(U - Lv);
                    const mU = M[rp + x], mL = M[rp + x - 1] + dl;
                    if (mL < mU) { M[r + x] = mL + cU; back[r + x] = -1; }
                    else { M[r + x] = mU + cU; back[r + x] = 0; }
                }
            }
            if (protect) for (let x = 0; x < w; x++) M[r + x] += protect[r + x] * PROTECT_WEIGHT;
        }
    }

    // The single cheapest seam (exact, one-at-a-time seam carving).
    function findSeam(gray, protect, S, w, h, M, back) {
        computeDP(gray, protect, S, w, h, M, back);
        const seam = new Int32Array(h);
        const last = (h - 1) * S;
        let bx = 0, bv = Infinity;
        for (let x = 0; x < w; x++) if (M[last + x] < bv) { bv = M[last + x]; bx = x; }
        for (let y = h - 1; y >= 0; y--) {
            seam[y] = bx;
            bx += back[y * S + bx];
        }
        return seam;
    }

    // Up to k cheap seams from ONE energy pass (the fast, approximate mode):
    // trace back from the cheapest bottom pixels and keep each seam that shares
    // no pixel with one already chosen. `used` is a scratch Uint8Array(S*h) of zeros.
    function findSeams(gray, protect, S, w, h, M, back, k, used) {
        if (k <= 1) return [findSeam(gray, protect, S, w, h, M, back)];
        computeDP(gray, protect, S, w, h, M, back);
        const last = (h - 1) * S;
        const order = new Int32Array(w);
        for (let x = 0; x < w; x++) order[x] = x;
        order.sort((a, b) => M[last + a] - M[last + b]);

        const seams = [];
        const tmp = new Int32Array(h);
        for (let i = 0; i < w && seams.length < k; i++) {
            let bx = order[i], ok = true;
            for (let y = h - 1; y >= 0; y--) {
                if (used[y * S + bx]) { ok = false; break; }
                tmp[y] = bx;
                bx += back[y * S + bx];
            }
            if (!ok) continue;
            for (let y = 0; y < h; y++) used[y * S + tmp[y]] = 1;
            seams.push(tmp.slice());
        }
        for (const seam of seams) for (let y = 0; y < h; y++) used[y * S + seam[y]] = 0;
        return seams;
    }

    function removeSeam(arrays, seam, S, w, h) {
        for (let y = 0; y < h; y++) {
            const r = y * S, x = seam[y];
            for (const a of arrays) if (a) a.copyWithin(r + x, r + x + 1, r + w);
        }
    }

    // Remove several non-overlapping seams at once (each row loses one pixel per seam).
    function removeSeams(arrays, seams, S, w, h) {
        const k = seams.length;
        if (k === 1) return removeSeam(arrays, seams[0], S, w, h);
        const xs = new Int32Array(k);
        for (let y = 0; y < h; y++) {
            for (let i = 0; i < k; i++) xs[i] = seams[i][y];
            xs.sort();
            const r = y * S;
            for (const a of arrays) {
                if (!a) continue;
                let wpos = r + xs[0];
                for (let j = 0; j < k; j++) {
                    const start = r + xs[j] + 1, end = j + 1 < k ? r + xs[j + 1] : r + w;
                    if (end > start) a.copyWithin(wpos, start, end);
                    wpos += end - start;
                }
            }
        }
    }

    // How many seams to take from one energy pass. batch = fraction of the
    // current width (0 = exact, one seam per pass).
    function batchSize(batch, cw, remaining) {
        return Math.max(1, Math.min(remaining, Math.floor(cw * batch)));
    }

    // ---------- vertical passes (change width) ----------

    // Each pass is a generator that yields once per seam, so callers can run
    // the work in slices (e.g. to keep a UI responsive) or just drain it.
    function* shrinkWidth(px, protect, w, h, targetW, batch) {
        const S = w;
        const gray = new Float32Array(w * h);
        for (let i = 0; i < w * h; i++) gray[i] = lumaOf(px[i]);
        const pr = protect ? Float32Array.from(protect, v => v / 255) : null;
        const M = new Float32Array(w * h), back = new Int8Array(w * h);

        const used = batch > 0 ? new Uint8Array(w * h) : null;
        let cw = w;
        while (cw > targetW) {
            const seams = findSeams(gray, pr, S, cw, h, M, back, batchSize(batch, cw, cw - targetW), used);
            removeSeams([px, gray, pr], seams, S, cw, h);
            cw -= seams.length;
            for (let i = 0; i < seams.length; i++) yield;
        }
        // Compact to stride targetW.
        const out = new Uint32Array(targetW * h);
        const outP = protect ? new Uint8Array(targetW * h) : null;
        for (let y = 0; y < h; y++) {
            out.set(px.subarray(y * S, y * S + targetW), y * targetW);
            if (outP) for (let x = 0; x < targetW; x++) outP[y * targetW + x] = Math.round(pr[y * S + x] * 255);
        }
        return { px: out, protect: outP };
    }

    function* enlargeWidthOnce(px, protect, w, h, k, batch) {
        // Find k seams on a working copy, tracking each pixel's original column.
        const S = w;
        const gray = new Float32Array(w * h);
        for (let i = 0; i < w * h; i++) gray[i] = lumaOf(px[i]);
        const pr = protect ? Float32Array.from(protect, v => v / 255) : null;
        const idx = new Int32Array(w * h);
        for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) idx[y * S + x] = x;
        const M = new Float32Array(w * h), back = new Int8Array(w * h);

        const dup = new Uint8Array(w * h); // how many copies to insert after each original pixel
        const used = batch > 0 ? new Uint8Array(w * h) : null;
        let cw = w, found = 0;
        while (found < k) {
            const seams = findSeams(gray, pr, S, cw, h, M, back, batchSize(batch, cw, k - found), used);
            for (const seam of seams) for (let y = 0; y < h; y++) dup[y * w + idx[y * S + seam[y]]]++;
            removeSeams([gray, pr, idx], seams, S, cw, h);
            cw -= seams.length;
            found += seams.length;
            for (let i = 0; i < seams.length; i++) yield;
        }

        const nw = w + k;
        const out = new Uint32Array(nw * h);
        const outP = protect ? new Uint8Array(nw * h) : null;
        for (let y = 0; y < h; y++) {
            let o = y * nw;
            const r = y * w;
            for (let x = 0; x < w; x++) {
                const p = px[r + x];
                out[o] = p;
                if (outP) outP[o] = protect[r + x];
                o++;
                for (let d = dup[r + x]; d > 0; d--) {
                    const nb = px[r + (x + 1 < w ? x + 1 : x)];
                    out[o] = avgPixel(p, nb);
                    if (outP) outP[o] = protect[r + x];
                    o++;
                }
            }
        }
        return { px: out, protect: outP };
    }

    function* enlargeWidth(px, protect, w, h, targetW, batch) {
        // Insert at most ~50% of the current width per pass, otherwise the same
        // seams get reused and the result smears.
        let cw = w;
        while (cw < targetW) {
            const k = Math.min(targetW - cw, Math.max(1, Math.floor(cw * 0.5)));
            ({ px, protect } = yield* enlargeWidthOnce(px, protect, cw, h, k, batch));
            cw += k;
        }
        return { px, protect };
    }

    function* resizeWidth(px, protect, w, h, targetW, batch) {
        if (targetW === w) return { px, protect };
        return targetW < w
            ? yield* shrinkWidth(px, protect, w, h, targetW, batch)
            : yield* enlargeWidth(px, protect, w, h, targetW, batch);
    }

    // ---------- plain bilinear resample (for the "amount" blend) ----------

    function bilinear(px, w, h, nw, nh) {
        if (nw === w && nh === h) return px;
        const src = new Uint8Array(px.buffer, px.byteOffset, w * h * 4);
        const out = new Uint32Array(nw * nh);
        const dst = new Uint8Array(out.buffer);
        const sx = w / nw, sy = h / nh;
        for (let y = 0; y < nh; y++) {
            let fy = (y + 0.5) * sy - 0.5; if (fy < 0) fy = 0;
            const y0 = Math.min(h - 1, Math.floor(fy)), y1 = Math.min(h - 1, y0 + 1), ty = fy - y0;
            for (let x = 0; x < nw; x++) {
                let fx = (x + 0.5) * sx - 0.5; if (fx < 0) fx = 0;
                const x0 = Math.min(w - 1, Math.floor(fx)), x1 = Math.min(w - 1, x0 + 1), tx = fx - x0;
                const a = (y0 * w + x0) * 4, b = (y0 * w + x1) * 4, c = (y1 * w + x0) * 4, d = (y1 * w + x1) * 4;
                const o = (y * nw + x) * 4;
                for (let ch = 0; ch < 4; ch++) {
                    const top = src[a + ch] + (src[b + ch] - src[a + ch]) * tx;
                    const bot = src[c + ch] + (src[d + ch] - src[c + ch]) * tx;
                    dst[o + ch] = Math.round(top + (bot - top) * ty);
                }
            }
        }
        return out;
    }

    // ---------- public API ----------
    //
    // carveSteps(rgba, width, height, newWidth, newHeight, options)
    //   Generator: yields progress (0..1) after every seam, returns the result.
    //   Lets a caller do the work in time slices and show progress.
    // carve(...same...)
    //   Runs carveSteps to completion and returns the result.
    //
    //   rgba     Uint8Array/Uint8ClampedArray, width*height*4
    //   options  { amount: 0..1 (default 1), protect: Uint8Array(width*height) | null,
    //              order: 'auto' | 'widthFirst' | 'heightFirst',
    //              batch: 0 = exact (one seam per energy pass, best quality);
    //                     >0 = take up to this fraction of the width per pass
    //                     (e.g. 0.01 ≈ 16 seams on a 1600 px image) — much faster, slightly approximate,
    //              onProgress: fn(fraction 0..1)   (carve only) }
    // result   { data: Uint8Array, width, height }

    function* carveSteps(rgba, width, height, newWidth, newHeight, options = {}) {
        newWidth = Math.max(1, Math.round(newWidth));
        newHeight = Math.max(1, Math.round(newHeight));
        const amount = options.amount == null ? 1 : Math.max(0, Math.min(1, options.amount));
        const batch = Math.max(0, Math.min(0.25, options.batch || 0));

        // Content-aware part covers `amount` of the size change; plain scaling does the rest.
        const cw = Math.max(1, Math.round(width + (newWidth - width) * amount));
        const ch = Math.max(1, Math.round(height + (newHeight - height) * amount));

        let px = toPacked(rgba, width, height);
        let protect = options.protect || null;

        // One yield per seam; total seams = |dw| + |dh|.
        const dw = Math.abs(cw - width), dh = Math.abs(ch - height);
        const total = dw + dh || 1;
        let done = 0;
        function* counted(it) {
            let r;
            while (!(r = it.next()).done) { done++; yield done / total; }
            return r.value;
        }
        const widthFirst = options.order === 'widthFirst' ||
            (options.order !== 'heightFirst' && dw >= dh);

        function* doWidth(w, h) {
            const r = yield* counted(resizeWidth(px, protect, w, h, cw, batch));
            px = r.px; protect = r.protect;
        }
        function* doHeight(w, h) {
            if (ch === h) return;
            const t = transpose(px, w, h, Uint32Array);
            const tp = protect ? transpose(protect, w, h, Uint8Array) : null;
            const r = yield* counted(resizeWidth(t, tp, h, w, ch, batch));
            px = transpose(r.px, ch, w, Uint32Array);
            protect = r.protect ? transpose(r.protect, ch, w, Uint8Array) : null;
        }

        if (widthFirst) { yield* doWidth(width, height); yield* doHeight(cw, height); }
        else { yield* doHeight(width, height); yield* doWidth(width, ch); }

        px = bilinear(px, cw, ch, newWidth, newHeight);
        return { data: fromPacked(px, newWidth, newHeight), width: newWidth, height: newHeight };
    }

    function carve(rgba, width, height, newWidth, newHeight, options = {}) {
        const it = carveSteps(rgba, width, height, newWidth, newHeight, options);
        let r;
        while (!(r = it.next()).done) if (options.onProgress) options.onProgress(r.value);
        if (options.onProgress) options.onProgress(1);
        return r.value;
    }

    // Plain bilinear resize of RGBA8 data (used for the fast low-res preview).
    function resize(rgba, width, height, newWidth, newHeight) {
        newWidth = Math.max(1, Math.round(newWidth));
        newHeight = Math.max(1, Math.round(newHeight));
        const px = bilinear(toPacked(rgba, width, height), width, height, newWidth, newHeight);
        return { data: fromPacked(px, newWidth, newHeight), width: newWidth, height: newHeight };
    }

    return { carve, carveSteps, resize };
})();

// @@NODE_EXPORT@@ (everything below is stripped by build.js when bundling for Affinity)
if (typeof module !== 'undefined') module.exports = SeamCarve;
