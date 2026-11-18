// Content-Aware Scale for Affinity (3.3+ Scripting).
//
// Select ONE pixel layer or image layer and run the script. While you adjust
// the size, a fast low-resolution preview is drawn on the canvas and the
// full-quality image is generated in the background, with progress shown in
// the dialog. Click OK to place it.
//
// Bundled by build.js together with seamcarve.js. Edit the sources, not dist/.

'use strict';

const { app } = require('/application.js');
const { Dialog, DialogResult } = require('/dialog.js');
const { Document, InsertionMode } = require('/document.js');
const { DocumentCommand, AddChildNodesCommandBuilder, CompoundCommandBuilder, NodeMoveType } = require('/commands.js');
const { ImageNodeDefinition, NodeChildType } = require('/nodes.js');
const { PixelBuffer, RasterFormat } = require('/rasterobject.js');
const { Rectangle, Transform } = require('/geometry.js');
const { Selection } = require('/selections.js');
const { setTimeout } = require('/timers.js');
const { UnitType } = require('/units.js');

const TITLE = 'Content-Aware Scale';
const PREVIEW_SIZES = [300, 600, 1000];   // long-edge pixels for Fast / Balanced / Detailed
const MAX_SCALE = 4;                      // largest allowed size, as a multiple of the original
const SLICE_MS = 40;                      // background work per timer tick (keeps the dialog responsive)
const PLACEHOLDER_MS = 250;               // how often the LOADING placeholder is redrawn
const PLACEHOLDER_SIZE = 400;             // long edge of the placeholder when there's no preview to dim

function isOk(result) {
    return (result?.value ?? result) == DialogResult.Ok.value;
}

// ---------- pixels in / out ----------

function readPixels(node) {
    const w = node.rasterWidth, h = node.rasterHeight;
    const buf = PixelBuffer.create(w, h, RasterFormat.RGBA8);
    try {
        node.copyTo(buf, new Rectangle(0, 0, w, h), 0, 0);
    } catch (e) {
        // Fallback: if the layer is already RGBA8, a compatible buffer is identical.
        if (node.rasterFormat?.value !== RasterFormat.RGBA8.value) throw e;
        return { data: new Uint8Array(node.createCompatibleBuffer(true).buffer).slice(), w, h };
    }
    return { data: new Uint8Array(buf.buffer).slice(), w, h };
}

function toBitmap(img) {
    const pb = PixelBuffer.create(img.width, img.height, RasterFormat.RGBA8);
    new Uint8Array(pb.buffer).set(img.data);
    return pb.createCompatibleBitmap(true);
}

// ---------- placement ----------
//
// The new layer is built in the original layer's own coordinate space, so it
// keeps the original's position, rotation and pixel density:
//   original.transform · translate(baseBox origin) · scale(native units per pixel × fullSize / bitmapSize)
// For the low-res preview the bitmap is smaller, so the scale enlarges it to cover the same area.

function placementTransform(node, src, newW, newH, bitmapW, bitmapH) {
    const box = node.baseBox;
    const unitsX = box.width / src.w, unitsY = box.height / src.h;   // base units per source pixel
    return Transform.multiply(node.transform, Transform.multiply(
        Transform.createTranslate(box.x, box.y),
        Transform.createScale(unitsX * newW / bitmapW, unitsY * newH / bitmapH)));
}

// Where the finished layer should land, in spread coordinates (unrotated layers only).
function expectedSpreadBox(node, src, newW, newH) {
    const ob = node.getSpreadBaseBox();
    return new Rectangle(ob.x, ob.y, ob.width * newW / src.w, ob.height * newH / src.h);
}

function rectToRect(from, to) {
    return Transform.multiply(Transform.createTranslate(to.x, to.y), Transform.multiply(
        Transform.createScale(to.width / from.width, to.height / from.height),
        Transform.createTranslate(-from.x, -from.y)));
}

function isAxisAligned(xf) {
    const d = xf.data;   // [a, b, tx, c, d, ty]
    return Math.abs(d[1]) < 1e-9 && Math.abs(d[3]) < 1e-9;
}

function childrenOf(n) {
    try { return n ? n.children.toArray() : []; } catch (e) { return []; }
}

// Labels given to temporary layers, so leftovers can be found and removed.
const PREVIEW_LABEL = `${TITLE} preview`;
const LOADING_LABEL = `${TITLE} loading`;

// Remove previews using both the immediate and the queued command. Outside a
// dialog, Affinity doesn't always drop a preview with the immediate one alone.
function clearAllPreviews(doc) {
    try { doc.clearPreviews(); } catch (e) { /* ignore */ }
    try { doc.clearPreviewsAsync(() => {}); } catch (e) { /* ignore */ }
}

// Delete any preview/placeholder layer that Affinity kept as a real layer.
function removeStrayPlaceholders(doc, node) {
    const stray = [...childrenOf(node.parent), ...childrenOf(node)].filter(n => {
        try { return n.userDescription === PREVIEW_LABEL || n.userDescription === LOADING_LABEL; }
        catch (e) { return false; }
    });
    if (stray.length)
        doc.executeCommand(DocumentCommand.createDeleteSelection(Selection.create(doc, stray), true));
}

// Command that adds an image layer into the ORIGINAL'S PARENT (i.e. as a sibling
// of the original, on top of the stack). Targeting the original itself makes
// Affinity nest the new layer inside it, where it's clipped to the original's
// bounds and hidden along with it.
function buildAddCommand(node, bitmap, xf, label) {
    const def = ImageNodeDefinition.create(RasterFormat.RGBA8);
    def.bitmap = bitmap;
    def.transform = xf;
    def.userDescription = label;

    const add = AddChildNodesCommandBuilder.create();
    const parent = node.parent;
    if (parent) {
        add.setInsertionTarget(parent);
        add.setInsertionMode(InsertionMode.Inside);
    }
    add.addNode(def);
    return add.createCommand(true, NodeChildType.Main);
}

// Preview image: the carved result in the top-left, with a checkerboard filling
// the rest of the original's area so the original doesn't show through.
function composePreview(small, coverW, coverH) {
    const w = Math.max(small.width, coverW), h = Math.max(small.height, coverH);
    const out = new Uint8Array(w * h * 4);
    const cell = Math.max(4, Math.round(Math.max(w, h) / 40));
    for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
            const o = (y * w + x) * 4;
            if (x < small.width && y < small.height) {
                const i = (y * small.width + x) * 4;
                out[o] = small.data[i]; out[o + 1] = small.data[i + 1];
                out[o + 2] = small.data[i + 2]; out[o + 3] = small.data[i + 3];
            } else {
                const v = ((Math.floor(x / cell) + Math.floor(y / cell)) & 1) ? 205 : 235;
                out[o] = out[o + 1] = out[o + 2] = v; out[o + 3] = 255;
            }
        }
    }
    return { data: out, width: w, height: h };
}

// Plain ASCII so it renders in any dialog font.
function progressBar(f) {
    const n = 20, k = Math.round(Math.max(0, Math.min(1, f)) * n);
    return '[' + '#'.repeat(k) + '-'.repeat(n - k) + `] ${Math.round(f * 100)}%`;
}

// ---------- dialog ----------

function buildDialog(w, h) {
    const dlg = Dialog.create(TITLE);
    const col = dlg.addColumn();

    // Pixel fields and percentage fields are linked; each has a popup slider.
    const size = col.addGroup('New size');
    dlg.width = size.addUnitValueEditor('Width', UnitType.Pixel, UnitType.Pixel, w, 1, w * MAX_SCALE)
        .setShowPopupSlider(true).setPrecision(0);
    dlg.widthPct = size.addUnitValueEditor('Width %', UnitType.Percentage, UnitType.Percentage, 100, 1, 100 * MAX_SCALE)
        .setShowPopupSlider(true).setPrecision(0);
    dlg.height = size.addUnitValueEditor('Height', UnitType.Pixel, UnitType.Pixel, h, 1, h * MAX_SCALE)
        .setShowPopupSlider(true).setPrecision(0);
    dlg.heightPct = size.addUnitValueEditor('Height %', UnitType.Percentage, UnitType.Percentage, 100, 1, 100 * MAX_SCALE)
        .setShowPopupSlider(true).setPrecision(0);
    dlg.info = size.addStaticText('', `Original ${w} × ${h} px`);

    const opts = col.addGroup('Options');
    dlg.amount = opts.addUnitValueEditor('Amount', UnitType.Percentage, UnitType.Percentage, 100, 0, 100)
        .setShowPopupSlider(true).setPrecision(0);
    dlg.order = opts.addComboBox('Seam order', ['Auto', 'Width first', 'Height first'], 0);
    dlg.keep = opts.addCheckBox('Keep original (hidden)', true);

    const pv = col.addGroup('Preview');
    dlg.preview = pv.addCheckBox('Live preview', true);
    dlg.quality = pv.addComboBox('Preview quality', ['Fast', 'Balanced', 'Detailed'], 0);

    // Progress is shown two ways: a read-only % field (value controls repaint
    // reliably) and a full-width status line. The status line starts with long
    // text so its initial width fits the longest message.
    const rg = col.addGroup('Full-quality render');
    dlg.progress = rg.addUnitValueEditor('Progress', UnitType.Percentage, UnitType.Percentage, 0, 0, 100)
        .setPrecision(0);
    dlg.progress.isEnabled = false;
    dlg.status = rg.addStaticText('', 'Generating full-quality image…  [--------------------] 100%')
        .setIsFullWidth(true);
    return dlg;
}

function readSettings(dlg) {
    return {
        w: Math.max(1, Math.round(dlg.width.value)),
        h: Math.max(1, Math.round(dlg.height.value)),
        amount: dlg.amount.value / 100,
        order: ['auto', 'widthFirst', 'heightFirst'][dlg.order.selectedIndex ?? 0] ?? 'auto',
        keep: !!dlg.keep.value,
        preview: !!dlg.preview.value,
        quality: dlg.quality.selectedIndex ?? 0,
    };
}

// The settings that determine the full-quality result.
function renderKey(o) {
    return JSON.stringify([o.w, o.h, o.amount, o.order]);
}

// ---------- main ----------

let hasRun = false;

function main() {
    if (hasRun) return;   // guards against both the host and the module body invoking main()
    hasRun = true;

    const doc = Document.current;
    if (!doc) { app.alert('Open a document first.', TITLE); return; }

    const node = doc.selection.firstNode;
    if (!node || !node.rasterInterface) {
        app.alert('Select a single pixel layer or image layer, then run this script again.', TITLE);
        return;
    }

    let src;
    try {
        src = readPixels(node);
    } catch (e) {
        app.alert(`Couldn't read this layer's pixels:\n${e}`, TITLE);
        return;
    }

    // Low-res copies of the source, one per preview quality, made on demand.
    const proxies = [];
    function proxy(q) {
        if (!proxies[q]) {
            const s = Math.min(1, PREVIEW_SIZES[q] / Math.max(src.w, src.h));
            const r = s < 1 ? SeamCarve.resize(src.data, src.w, src.h, src.w * s, src.h * s)
                            : { data: src.data, width: src.w, height: src.h };
            proxies[q] = { ...r, s: r.width / src.w };
        }
        return proxies[q];
    }

    const dlg = buildDialog(src.w, src.h);

    // ----- full-quality render, done in time slices in the background -----
    // job = { key, steps (generator), progress, result, timer }
    let job = null;

    // Show render progress in both the % field and the status line.
    // Setting the field's value may fire the dialog's change handler, so
    // suppress it while we write (see `syncing`).
    function showProgress(fraction, message) {
        syncing = true;
        try {
            if (fraction != null) dlg.progress.value = Math.round(fraction * 100);
            dlg.status.text = message;
        } catch (e) {
            /* ignore UI errors so rendering continues */
        } finally {
            syncing = false;
        }
    }

    function cancelJob() {
        if (job?.timer) { try { job.timer.cancel(); } catch (e) { /* already fired */ } }
        job = null;
    }

    function startJob(o) {
        const key = renderKey(o);
        if (job && job.key === key) return;      // already running / finished for these settings
        cancelJob();
        const me = job = {
            key, progress: 0, result: null, timer: null,
            steps: SeamCarve.carveSteps(src.data, src.w, src.h, o.w, o.h, { amount: o.amount, order: o.order }),
        };
        showProgress(0, `Generating full-quality image…  ${progressBar(0)}`);

        const tick = () => {
            if (job !== me || me.result) return;
            try {
                const t0 = Date.now();
                while (Date.now() - t0 < SLICE_MS) {
                    const r = me.steps.next();
                    if (r.done) { me.result = r.value; break; }
                    me.progress = r.value;
                }
            } catch (e) {
                showProgress(null, `Generate error: ${e?.message ?? e}`);
                job = null;
                return;
            }
            if (me.result) {
                showProgress(1, 'Done: full-quality image ready. Click OK to place it.');
            } else {
                showProgress(me.progress, `Generating full-quality image…  ${progressBar(me.progress)}`);
                me.timer = setTimeout(0, tick);
            }
        };
        me.timer = setTimeout(0, tick);
    }

    // Get the render job for these settings (reusing any progress already
    // made in the background) and stop its dialog-driven timer.
    function ensureJob(o) {
        if (!job || job.key !== renderKey(o)) {
            cancelJob();
            job = { key: renderKey(o), progress: 0, result: null, timer: null,
                    steps: SeamCarve.carveSteps(src.data, src.w, src.h, o.w, o.h, { amount: o.amount, order: o.order }) };
        }
        if (job.timer) { try { job.timer.cancel(); } catch (e) { /* ignore */ } }
        job.timer = null;
        return job;
    }

    // ----- linked px / % fields -----
    let prevSize = { w: src.w, h: src.h, wp: 100, hp: 100 };
    let syncing = false;
    function syncSizeFields() {
        syncing = true;   // setting .value may re-fire the change handler
        try {
            const w = Math.round(dlg.width.value), h = Math.round(dlg.height.value);
            const wp = dlg.widthPct.value, hp = dlg.heightPct.value;
            if (w !== prevSize.w) dlg.widthPct.value = 100 * w / src.w;
            else if (wp !== prevSize.wp) dlg.width.value = Math.max(1, Math.round(src.w * wp / 100));
            if (h !== prevSize.h) dlg.heightPct.value = 100 * h / src.h;
            else if (hp !== prevSize.hp) dlg.height.value = Math.max(1, Math.round(src.h * hp / 100));
            prevSize = {
                w: Math.round(dlg.width.value), h: Math.round(dlg.height.value),
                wp: dlg.widthPct.value, hp: dlg.heightPct.value,
            };
        } finally {
            syncing = false;
        }
    }

    // ----- low-res live preview -----
    let lastPreviewKey = null;
    let lastShown = null;   // last preview bitmap data (reused, dimmed, for the LOADING placeholder)

    function update() {
        syncSizeFields();
        const o = readSettings(dlg);
        const unchanged = o.w === src.w && o.h === src.h;

        if (unchanged) {
            cancelJob();
            lastPreviewKey = null;
            doc.clearPreviews();
            dlg.info.text = `Original ${src.w} × ${src.h} px`;
            showProgress(0, 'Change the size to see a preview.');
            return;
        }

        let previewNote = '';
        if (!o.preview) {
            lastPreviewKey = null;
            lastShown = null;
            doc.clearPreviews();
        } else {
            const key = JSON.stringify([renderKey(o), o.quality]);
            if (key !== lastPreviewKey) {
                lastPreviewKey = key;
                const t0 = Date.now();
                const p = proxy(o.quality);
                const pw = Math.max(1, Math.round(o.w * p.s)), ph = Math.max(1, Math.round(o.h * p.s));
                const small = SeamCarve.carve(p.data, p.width, p.height, pw, ph, { amount: o.amount, order: o.order });
                const shown = composePreview(small, p.width, p.height);
                // Full-resolution size that the (possibly padded) preview bitmap stands for.
                const coverW = Math.max(o.w, src.w), coverH = Math.max(o.h, src.h);
                const xf = placementTransform(node, src, coverW, coverH, shown.width, shown.height);
                doc.executeCommand(buildAddCommand(node, toBitmap(shown), xf, PREVIEW_LABEL), true);
                lastShown = shown;
                previewNote = `  ·  preview ${Date.now() - t0} ms`;
            }
        }
        dlg.info.text = `Original ${src.w} × ${src.h} px  →  ${o.w} × ${o.h} px${previewNote}`;
        startJob(o);
    }

    // Note: onControlValueChangedHandler is write-only (setter), so keep our own reference.
    const onChange = () => {
        if (syncing) return;
        try { update(); }
        catch (e) {
            lastPreviewKey = null;
            dlg.status.text = `Preview error: ${e?.message ?? e}`;
            console.log(`${TITLE} preview failed: ${e?.stack ?? e}`);
        }
    };
    dlg.onControlValueChangedHandler = onChange;
    onChange();

    const ok = isOk(dlg.runModal());
    const o = readSettings(dlg);
    if (!ok || (o.w === src.w && o.h === src.h)) { cancelJob(); doc.clearPreviews(); return; }

    const me = ensureJob(o);
    const finish = () => {
        clearAllPreviews(doc);
        job = null;
        try {
            commit(doc, node, src, o, me.result);
        } catch (e) {
            app.alert(`Couldn't place the new layer:\n${e?.message ?? e}`, TITLE);
        }
        // Make sure the LOADING placeholder is gone: clear again, delete any
        // leftover placeholder layer, and repeat once Affinity has caught up.
        const cleanUp = () => {
            clearAllPreviews(doc);
            try { removeStrayPlaceholders(doc, node); } catch (e) { /* ignore */ }
        };
        cleanUp();
        setTimeout(150, cleanUp);
    };

    // Already rendered in the background while the dialog was open.
    if (me.result) { finish(); return; }

    // Otherwise: show a LOADING placeholder where the image will appear and
    // keep rendering in slices, so Affinity stays responsive and redraws it.
    const coverW = Math.max(o.w, src.w), coverH = Math.max(o.h, src.h);
    const fit = PLACEHOLDER_SIZE / Math.max(coverW, coverH);
    const base = lastShown;   // matches the current settings (null when preview is off)
    const phW = Math.max(1, Math.round(coverW * fit)), phH = Math.max(1, Math.round(coverH * fit));

    let lastDraw = 0;
    function drawPlaceholder() {
        try {
            const img = LoadingOverlay.render(base, phW, phH, me.progress);
            const xf = placementTransform(node, src, coverW, coverH, img.width, img.height);
            doc.executeCommand(buildAddCommand(node, toBitmap(img), xf, LOADING_LABEL), true);
        } catch (e) {
            console.log(`${TITLE}: placeholder failed: ${e?.stack ?? e}`);
        }
        lastDraw = Date.now();
    }

    function tick() {
        try {
            const t0 = Date.now();
            while (Date.now() - t0 < SLICE_MS) {
                const r = me.steps.next();
                if (r.done) { me.result = r.value; break; }
                me.progress = r.value;
            }
        } catch (e) {
            doc.clearPreviews();
            job = null;
            app.alert(`Content-aware scaling failed:\n${e?.message ?? e}`, TITLE);
            return;
        }
        if (me.result) { finish(); return; }
        if (Date.now() - lastDraw >= PLACEHOLDER_MS) drawPlaceholder();
        setTimeout(0, tick);
    }

    drawPlaceholder();
    setTimeout(0, tick);
}

// Add the full-quality layer as a sibling directly above the original, then
// hide (or delete) the original.
function commit(doc, node, src, o, full) {
    const parent = node.parent;
    const before = [...childrenOf(parent), ...childrenOf(node)];
    const isNew = n => !before.some(b => b.isSameNode(n));

    const expected = expectedSpreadBox(node, src, o.w, o.h);
    const axisAligned = isAxisAligned(node.baseToSpreadTransform);
    const xf = placementTransform(node, src, o.w, o.h, full.width, full.height);
    const label = `${TITLE} ${o.w}×${o.h}`;
    doc.executeCommand(buildAddCommand(node, toBitmap(full), xf, label));

    // Find the layer we just added: look among the original's siblings first,
    // then inside the original in case Affinity nested it there anyway.
    const newNode = childrenOf(parent).find(isNew) ?? childrenOf(node).find(isNew)
        ?? doc.selection.firstNode;
    if (!newNode || newNode.isSameNode(node)) {
        app.alert('The new layer was created but could not be located to position it.', TITLE);
        return;
    }

    // Put it directly in front of the original, as a sibling (not a child).
    // Children run back to front, so "After" = in front.
    const next = node.nextSibling;
    if (!(newNode.parent?.isSameNode(parent) && next && next.isSameNode(newNode)))
        doc.executeCommand(DocumentCommand.createMoveNodes(newNode.selfSelection, node, NodeMoveType.After));

    // Safety net: if Affinity sized the new layer differently than expected
    // (e.g. a different native DPI for new images), snap it into place.
    if (axisAligned) {
        const got = newNode.getSpreadBaseBox();
        const off = Math.max(Math.abs(got.x - expected.x), Math.abs(got.y - expected.y),
                             Math.abs(got.width - expected.width), Math.abs(got.height - expected.height));
        if (off > 0.5)
            doc.executeCommand(DocumentCommand.createTransform(newNode.selfSelection, rectToRect(got, expected)));
    }

    doc.executeCommand(o.keep
        ? DocumentCommand.createHideSelection(node.selfSelection)
        : DocumentCommand.createDeleteSelection(node.selfSelection, true));

    doc.selection = [newNode];

    // Report if it still ended up nested, so we know which API behaviour to adapt to.
    if (newNode.parent?.isSameNode(node))
        app.alert('Note: Affinity placed the new layer inside the original. Drag it out in the Layers panel.', TITLE);
}

module.exports.main = main;
main();
