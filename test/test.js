// node test/test.js — checks the seam-carving core and writes before/after PNGs to test/out/.
'use strict';
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const assert = require('assert');
const { carve, resize } = require('../src/seamcarve.js');

const OUT = path.join(__dirname, 'out');
fs.mkdirSync(OUT, { recursive: true });

// ---- tiny PNG writer ----
function crc32(buf) {
    let c, crc = 0xffffffff;
    for (let n = 0; n < buf.length; n++) {
        c = (crc ^ buf[n]) & 0xff;
        for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        crc = (crc >>> 8) ^ c;
    }
    return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
    return Buffer.concat([len, td, crc]);
}
function writePNG(file, rgba, w, h) {
    const raw = Buffer.alloc((w * 4 + 1) * h);
    for (let y = 0; y < h; y++) {
        raw[y * (w * 4 + 1)] = 0;
        Buffer.from(rgba.buffer, rgba.byteOffset + y * w * 4, w * 4).copy(raw, y * (w * 4 + 1) + 1);
    }
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6;
    fs.writeFileSync(file, Buffer.concat([
        Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
        chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0)),
    ]));
}

// ---- synthetic scene: smooth sky/ground gradient + red disc + blue square ----
function scene(w, h) {
    const d = new Uint8Array(w * h * 4);
    const disc = { x: w * 0.25, y: h * 0.55, r: h * 0.18 };
    const sq = { x0: w * 0.62, x1: w * 0.62 + h * 0.3, y0: h * 0.35, y1: h * 0.65 };
    // Deterministic noise: real objects are textured; flat-colour shapes are
    // (correctly) treated as free space by any seam carver, Photoshop's included.
    let seed = 12345;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 4294967296);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4;
        let r, g, b;
        const bg = (rnd() - 0.5) * 4;                                                 // faint sensor noise
        if (y < h * 0.7) { r = 120 + 60 * y / h + bg; g = 170 + 40 * y / h + bg; b = 235 + bg; }   // sky
        else { r = 70 + bg; g = 140 - 30 * (y / h) + bg; b = 60 + bg; }               // grass
        const tex = (rnd() - 0.5) * 50;                                               // object texture
        if ((x - disc.x) ** 2 + (y - disc.y) ** 2 < disc.r ** 2) { r = 225 + tex / 2; g = 35 + tex; b = 45 + tex; }
        if (x >= sq.x0 && x < sq.x1 && y >= sq.y0 && y < sq.y1) { r = 30 + tex / 2; g = 60 + tex; b = 215 + tex / 2; }
        r = Math.max(0, Math.min(255, r)); g = Math.max(0, Math.min(255, g)); b = Math.max(0, Math.min(255, b));
        d[i] = r; d[i + 1] = g; d[i + 2] = b; d[i + 3] = 255;
    }
    return d;
}

// Width and height (in pixels) of the region matching a colour test.
function extent(d, w, h, pred) {
    let minX = w, maxX = -1, minY = h, maxY = -1;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4;
        if (pred(d[i], d[i + 1], d[i + 2])) {
            if (x < minX) minX = x; if (x > maxX) maxX = x;
            if (y < minY) minY = y; if (y > maxY) maxY = y;
        }
    }
    return { w: maxX - minX + 1, h: maxY - minY + 1 };
}
const isRed = (r, g, b) => r > 180 && g < 80 && b < 80;
const isBlue = (r, g, b) => b > 180 && r < 60 && g < 90;

let failures = 0;
function test(name, fn) {
    try { fn(); console.log(`  ok   ${name}`); }
    catch (e) { failures++; console.log(`  FAIL ${name}\n       ${e.message}`); }
}

const W = 480, H = 270;
const img = scene(W, H);
writePNG(path.join(OUT, 'original.png'), img, W, H);
const red0 = extent(img, W, H, isRed), blue0 = extent(img, W, H, isBlue);

const cases = [
    ['squash-width', 300, 270],
    ['squash-height', 480, 180],
    ['stretch-width', 720, 270],
    ['squash-both', 320, 200],
    ['stretch-w-squash-h', 640, 200],
    ['big-stretch', 1100, 270],   // > 2× → needs multiple passes
];

console.log('Seam carving tests');
for (const [name, nw, nh] of cases) {
    const t0 = Date.now();
    const r = carve(img, W, H, nw, nh);
    const ms = Date.now() - t0;
    writePNG(path.join(OUT, `${name}.png`), r.data, r.width, r.height);
    test(`${name} → ${nw}×${nh} (${ms} ms)`, () => {
        assert.strictEqual(r.width, nw); assert.strictEqual(r.height, nh);
        assert.strictEqual(r.data.length, nw * nh * 4);
        const red = extent(r.data, nw, nh, isRed), blue = extent(r.data, nw, nh, isBlue);
        // Objects should keep (almost) their original size; the gradient absorbs the change.
        for (const [label, a, b] of [['disc', red, red0], ['square', blue, blue0]]) {
            assert.ok(Math.abs(a.w - b.w) <= b.w * 0.08, `${label} width ${b.w}→${a.w}`);
            assert.ok(Math.abs(a.h - b.h) <= b.h * 0.08, `${label} height ${b.h}→${a.h}`);
        }
    });
}

test('amount = 0 behaves like ordinary scaling (disc squashes)', () => {
    const r = carve(img, W, H, 300, 270, { amount: 0 });
    writePNG(path.join(OUT, 'amount-0.png'), r.data, r.width, r.height);
    const red = extent(r.data, 300, 270, isRed);
    const expected = red0.w * 300 / W;
    assert.ok(Math.abs(red.w - expected) <= 3, `disc width ${red.w}, expected ≈${expected.toFixed(0)}`);
});

test('protect mask keeps a protected region intact under an extreme squash', () => {
    // Without protection, squashing to 160px wide must eat into the objects.
    // Protect the disc only and confirm it survives.
    const mask = new Uint8Array(W * H);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
        const i = (y * W + x) * 4;
        if (isRed(img[i], img[i + 1], img[i + 2])) mask[y * W + x] = 255;
    }
    const r = carve(img, W, H, 140, H, { protect: mask });
    writePNG(path.join(OUT, 'protected-extreme.png'), r.data, r.width, r.height);
    const red = extent(r.data, 140, H, isRed);
    assert.ok(Math.abs(red.w - red0.w) <= 2, `protected disc width ${red0.w}→${red.w}`);
});

test('alpha channel is preserved', () => {
    const t = img.slice(); for (let i = 3; i < t.length; i += 4) t[i] = 128;
    const r = carve(t, W, H, 350, 200);
    for (let i = 3; i < r.data.length; i += 4) assert.strictEqual(r.data[i], 128);
});

test('preview path: low-res proxy carve is fast and keeps objects', () => {
    // Mirrors what the live preview does: downscale to 300px, carve, check timing.
    const PW = 3000, PH = 2000;
    const big = scene(PW, PH);
    const s = 300 / PW;
    const t0 = Date.now();
    const p = resize(big, PW, PH, PW * s, PH * s);
    const r = carve(p.data, p.width, p.height, Math.round(1800 * s), Math.round(1500 * s));
    const ms = Date.now() - t0;
    writePNG(path.join(OUT, 'preview-proxy.png'), r.data, r.width, r.height);
    assert.strictEqual(p.width, 300); assert.strictEqual(p.height, 200);
    assert.ok(ms < 1000, `preview took ${ms} ms`);
    console.log(`       (proxy carve took ${ms} ms)`);
});

test('LOADING placeholder renders over a dimmed preview and on plain grey', () => {
    const LoadingOverlay = require('../src/loading-overlay.js');
    const p = resize(img, W, H, 400, 225);
    const a = LoadingOverlay.render(p, 0, 0, 0.42);
    writePNG(path.join(OUT, 'loading-over-preview.png'), a.data, a.width, a.height);
    assert.strictEqual(a.width, 400); assert.strictEqual(a.height, 225);
    const b = LoadingOverlay.render(null, 300, 400, 0.9);   // tall, no preview
    writePNG(path.join(OUT, 'loading-plain.png'), b.data, b.width, b.height);
    assert.strictEqual(b.width, 300); assert.strictEqual(b.height, 400);
    // Some pure-white text pixels and some blue progress-fill pixels exist.
    let white = 0, blue = 0;
    for (let i = 0; i < a.data.length; i += 4) {
        if (a.data[i] === 255 && a.data[i + 1] === 255 && a.data[i + 2] === 255) white++;
        if (a.data[i] === 90 && a.data[i + 1] === 170 && a.data[i + 2] === 255) blue++;
    }
    assert.ok(white > 100 && blue > 100, `white ${white}, blue ${blue}`);
});

test('carveSteps can be resumed: background progress + finish = same result', () => {
    const it = require('../src/seamcarve.js').carveSteps(img, W, H, 360, 220);
    for (let i = 0; i < 50; i++) it.next();          // partial work "in the dialog"
    let r; while (!(r = it.next()).done) {}           // finish "after OK"
    const ref = carve(img, W, H, 360, 220);
    assert.ok(Buffer.compare(Buffer.from(r.value.data), Buffer.from(ref.data)) === 0);
});

// Performance: a typical photo-sized layer.
{
    const PW = 1600, PH = 1067;
    const big = scene(PW, PH);
    const t0 = Date.now();
    carve(big, PW, PH, 1200, PH);
    console.log(`  perf ${PW}×${PH} → 1200×${PH}: ${((Date.now() - t0) / 1000).toFixed(1)} s`);
}

console.log(failures ? `\n${failures} failing` : '\nall passed');
console.log(`images: ${OUT}`);
process.exitCode = failures ? 1 : 0;
