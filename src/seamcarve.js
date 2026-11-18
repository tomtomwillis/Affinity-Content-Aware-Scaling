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

    function findSeam(gray, protect, S, w, h, M, back) {
        // Row 0
        for (let x = 0; x < w; x++) M[x] = protect ? protect[x] * PROTECT_WEIGHT : 0;

        for (let y = 1; y < h; y++) {
            const r = y * S, rp = r - S;
            for (let x = 0; x < w; x++) {
                const xl = x > 0 ? x - 1 : x;
                const xr = x < w - 1 ? x + 1 : x;
                const L = gray[r + xl], R = gray[r + xr], U = gray[rp + x];
                const cU = Math.abs(R - L);
                let best = M[rp + x] + cU, dir = 0;
                if (x > 0) {
                    const v = M[rp + x - 1] + cU + Math.abs(U - L);
                    if (v < best) { best = v; dir = -1; }
                }
                if (x < w - 1) {
                    const v = M[rp + x + 1] + cU + Math.abs(U - R);
                    if (v < best) { best = v; dir = 1; }
                }
                if (protect) best += protect[r + x] * PROTECT_WEIGHT;
                M[r + x] = best;
                back[r + x] = dir;
            }
        }

        // Backtrack from the cheapest bottom pixel.
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

    function removeSeam(arrays, seam, S, w, h) {
        for (let y = 0; y < h; y++) {
            const r = y * S, x = seam[y];
            for (const a of arrays) if (a) a.copyWithin(r + x, r + x + 1, r + w);
        }
    }

    // ---------- vertical passes (change width) ----------

    // Each pass is a generator that yields once per seam, so callers can run
    // the work in slices (e.g. to keep a UI responsive) or just drain it.
    function* shrinkWidth(px, protect, w, h, targetW) {
        const S = w;
        const gray = new Float32Array(w * h);
        for (let i = 0; i < w * h; i++) gray[i] = lumaOf(px[i]);
        const pr = protect ? Float32Array.from(protect, v => v / 255) : null;
        const M = new Float64Array(w * h), back = new Int8Array(w * h);

        let cw = w;
        while (cw > targetW) {
            const seam = findSeam(gray, pr, S, cw, h, M, back);
            removeSeam([px, gray, pr], seam, S, cw, h);
            cw--;
            yield;
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

    function* enlargeWidthOnce(px, protect, w, h, k) {
        // Find k seams on a working copy, tracking each pixel's original column.
        const S = w;
        const gray = new Float32Array(w * h);
        for (let i = 0; i < w * h; i++) gray[i] = lumaOf(px[i]);
        const pr = protect ? Float32Array.from(protect, v => v / 255) : null;
        const idx = new Int32Array(w * h);
        for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) idx[y * S + x] = x;
        const M = new Float64Array(w * h), back = new Int8Array(w * h);

        const dup = new Uint8Array(w * h); // how many copies to insert after each original pixel
        let cw = w;
        for (let s = 0; s < k; s++) {
            const seam = findSeam(gray, pr, S, cw, h, M, back);
            for (let y = 0; y < h; y++) dup[y * w + idx[y * S + seam[y]]]++;
            removeSeam([gray, pr, idx], seam, S, cw, h);
            cw--;
            yield;
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

    function* enlargeWidth(px, protect, w, h, targetW) {
        // Insert at most ~50% of the current width per pass, otherwise the same
        // seams get reused and the result smears.
        let cw = w;
        while (cw < targetW) {
            const k = Math.min(targetW - cw, Math.max(1, Math.floor(cw * 0.5)));
            ({ px, protect } = yield* enlargeWidthOnce(px, protect, cw, h, k));
            cw += k;
        }
        return { px, protect };
    }

    function* resizeWidth(px, protect, w, h, targetW) {
        if (targetW === w) return { px, protect };
        return targetW < w
            ? yield* shrinkWidth(px, protect, w, h, targetW)
            : yield* enlargeWidth(px, protect, w, h, targetW);
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
    //              onProgress: fn(fraction 0..1)   (carve only) }
    // result   { data: Uint8Array, width, height }

    function* carveSteps(rgba, width, height, newWidth, newHeight, options = {}) {
        newWidth = Math.max(1, Math.round(newWidth));
        newHeight = Math.max(1, Math.round(newHeight));
        const amount = options.amount == null ? 1 : Math.max(0, Math.min(1, options.amount));

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
            const r = yield* counted(resizeWidth(px, protect, w, h, cw));
            px = r.px; protect = r.protect;
        }
        function* doHeight(w, h) {
            if (ch === h) return;
            const t = transpose(px, w, h, Uint32Array);
            const tp = protect ? transpose(protect, w, h, Uint8Array) : null;
            const r = yield* counted(resizeWidth(t, tp, h, w, ch));
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
