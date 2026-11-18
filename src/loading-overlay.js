// Draws a "LOADING 42%" placeholder image: a dimmed background with pixel-font
// text and a progress bar. Pure JS (no Affinity APIs) so it can be tested in Node.

'use strict';

const LoadingOverlay = (function () {
    // 5×7 pixel font, only the characters we need.
    const FONT = {
        'L': ['1....', '1....', '1....', '1....', '1....', '1....', '11111'],
        'O': ['.111.', '1...1', '1...1', '1...1', '1...1', '1...1', '.111.'],
        'A': ['.111.', '1...1', '1...1', '11111', '1...1', '1...1', '1...1'],
        'D': ['1111.', '1...1', '1...1', '1...1', '1...1', '1...1', '1111.'],
        'I': ['.111.', '..1..', '..1..', '..1..', '..1..', '..1..', '.111.'],
        'N': ['1...1', '11..1', '1.1.1', '1..11', '1...1', '1...1', '1...1'],
        'G': ['.111.', '1...1', '1....', '1.111', '1...1', '1...1', '.1111'],
        '0': ['.111.', '1...1', '1..11', '1.1.1', '11..1', '1...1', '.111.'],
        '1': ['..1..', '.11..', '..1..', '..1..', '..1..', '..1..', '.111.'],
        '2': ['.111.', '1...1', '....1', '...1.', '..1..', '.1...', '11111'],
        '3': ['11111', '...1.', '..1..', '...1.', '....1', '1...1', '.111.'],
        '4': ['...1.', '..11.', '.1.1.', '1..1.', '11111', '...1.', '...1.'],
        '5': ['11111', '1....', '1111.', '....1', '....1', '1...1', '.111.'],
        '6': ['..11.', '.1...', '1....', '1111.', '1...1', '1...1', '.111.'],
        '7': ['11111', '....1', '...1.', '..1..', '.1...', '.1...', '.1...'],
        '8': ['.111.', '1...1', '1...1', '.111.', '1...1', '1...1', '.111.'],
        '9': ['.111.', '1...1', '1...1', '.1111', '....1', '...1.', '.11..'],
        '%': ['11...', '11..1', '...1.', '..1..', '.1...', '1..11', '...11'],
        '.': ['.....', '.....', '.....', '.....', '.....', '.11..', '.11..'],
        ' ': ['.....', '.....', '.....', '.....', '.....', '.....', '.....'],
    };
    const GLYPH_W = 5, GLYPH_H = 7, ADVANCE = 6;   // advance includes 1px gap

    function fillRect(img, x0, y0, w, h, r, g, b, a) {
        const xs = Math.max(0, Math.round(x0)), ys = Math.max(0, Math.round(y0));
        const xe = Math.min(img.width, Math.round(x0 + w)), ye = Math.min(img.height, Math.round(y0 + h));
        for (let y = ys; y < ye; y++) {
            for (let x = xs; x < xe; x++) {
                const o = (y * img.width + x) * 4;
                img.data[o] = r; img.data[o + 1] = g; img.data[o + 2] = b; img.data[o + 3] = a;
            }
        }
    }

    function textWidth(text) {
        return text.length * ADVANCE - 1;
    }

    function drawText(img, text, x0, y0, scale, rgb) {
        for (let i = 0; i < text.length; i++) {
            const glyph = FONT[text[i]] || FONT[' '];
            for (let gy = 0; gy < GLYPH_H; gy++) {
                for (let gx = 0; gx < GLYPH_W; gx++) {
                    if (glyph[gy][gx] === '1')
                        fillRect(img, x0 + (i * ADVANCE + gx) * scale, y0 + gy * scale, scale, scale,
                                 rgb[0], rgb[1], rgb[2], 255);
                }
            }
        }
    }

    // base: { data, width, height } RGBA8 to dim underneath (or null for plain grey)
    // width/height: size of the placeholder when there is no base
    function render(base, width, height, fraction) {
        const w = base ? base.width : width, h = base ? base.height : height;
        const img = { data: new Uint8Array(w * h * 4), width: w, height: h };

        // Background: the preview darkened to ~35%, or flat dark grey.
        if (base) {
            for (let i = 0; i < w * h * 4; i += 4) {
                img.data[i] = base.data[i] * 0.35;
                img.data[i + 1] = base.data[i + 1] * 0.35;
                img.data[i + 2] = base.data[i + 2] * 0.35;
                img.data[i + 3] = 255;
            }
        } else {
            fillRect(img, 0, 0, w, h, 60, 60, 60, 255);
        }

        const pct = Math.round(Math.max(0, Math.min(1, fraction)) * 100);
        const text = `LOADING ${pct}%`;
        // Scale the text to about 60% of the width, but keep it within the height.
        const scale = Math.max(1, Math.floor(Math.min(w * 0.6 / textWidth(text), h * 0.18 / GLYPH_H)));
        const tw = textWidth(text) * scale, th = GLYPH_H * scale;

        const barW = Math.max(tw, Math.round(w * 0.6)), barH = Math.max(3, Math.round(th * 0.45));
        const gap = Math.round(th * 0.6);
        const blockH = th + gap + barH;
        const top = Math.round((h - blockH) / 2);

        drawText(img, text, Math.round((w - tw) / 2), top, scale, [255, 255, 255]);

        const bx = Math.round((w - barW) / 2), by = top + th + gap;
        fillRect(img, bx, by, barW, barH, 110, 110, 110, 255);                 // track
        fillRect(img, bx, by, barW * pct / 100, barH, 90, 170, 255, 255);      // fill
        return img;
    }

    return { render };
})();

// @@NODE_EXPORT@@ (everything below is stripped by build.js when bundling for Affinity)
if (typeof module !== 'undefined') module.exports = LoadingOverlay;
