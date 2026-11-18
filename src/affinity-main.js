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
// Seams taken per energy pass, as a fraction of the width (see seamcarve.js).
// 0 = exact one-seam-at-a-time; 0.01 is ~8× faster and looks the same in testing.
const SPEED_BATCH = [0.01, 0];            // index = dialog "Speed" choice: Fast, Best quality
const PREVIEW_BATCH = 0.01;
const SLICE_MS = 40;                      // background work per timer tick (keeps the dialog responsive)
const PLACEHOLDER_MS = 250;               // how often the LOADING placeholder is redrawn
const PLACEHOLDER_SIZE = 400;             // long edge of the placeholder when there's no preview to dim
// Failsafe: hide the LOADING placeholder if progress stops going up.
const STALL_MS = 3000;                    // no progress for this long → hide it
const STALL_AT_FULL_MS = 1000;            // at 100% but not placed yet for this long → hide it

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

function placementTransform(snap, src, newW, newH, bitmapW, bitmapH) {
    const box = snap.baseBox;
    const unitsX = box.width / src.w, unitsY = box.height / src.h;   // base units per source pixel
    return Transform.multiply(snap.transform, Transform.multiply(
        Transform.createTranslate(box.x, box.y),
        Transform.createScale(unitsX * newW / bitmapW, unitsY * newH / bitmapH)));
}

// Where the finished layer should land, in spread coordinates (unrotated layers only).
function expectedSpreadBox(snap, src, newW, newH) {
    const ob = snap.spreadBox;
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

// IMPORTANT: Affinity invalidates ("DISPOSED") every node handle a script holds
// whenever a document command runs, including preview commands. So never keep
// a node across commands: copy what we need into plain values up front, and
// look nodes up again by their id whenever we need to act on them.

const idOf = n => String(n.nodeId);

function copyRect(r) {
    return new Rectangle(r.x, r.y, r.width, r.height);
}

// Plain-value snapshot of the original layer, safe to use after commands run.
function snapshotNode(node) {
    return {
        id: idOf(node),
        baseBox: copyRect(node.baseBox),
        transform: node.transform.clone(),
        spreadBox: copyRect(node.getSpreadBaseBox()),
        axisAligned: isAxisAligned(node.baseToSpreadTransform),
    };
}

// A fresh Document object (its cached root node can go stale too).
function freshDoc(doc) {
    try {
        const cur = Document.current;
        if (cur && String(cur.persistentUuid) === String(doc.persistentUuid)) return cur;
    } catch (e) { /* fall through */ }
    return new Document(doc.handle);
}

// Every node in the document, using Affinity's own recursive listing.
function allNodes(doc) {
    const d = freshDoc(doc);
    try { return d.rootNode.children.all.toArray(); } catch (e) { /* fall back */ }
    const out = [], stack = [d.rootNode];
    while (stack.length) {
        const n = stack.pop();
        out.push(n);
        for (const c of childrenOf(n)) stack.push(c);
    }
    return out;
}

const descOf = n => { try { return n.userDescription; } catch (e) { return ''; } };
const isOurTemp = n => { const d = descOf(n); return d === PREVIEW_LABEL || d === LOADING_LABEL; };
const sameId = (n, id) => { try { return idOf(n) === id; } catch (e) { return false; } };

// Finds the ORIGINAL layer again after commands have run. Tries, in order:
// the cached handle, the current selection, a selection saved at the start,
// a search by id, and finally a search by size and position (in case ids
// change). Returns null if it really is gone.
function findOriginal(doc, cache, snap, src) {
    if (cache.node && sameId(cache.node, snap.id)) return cache.node;

    const tryNodes = list => { for (const n of list) if (sameId(n, snap.id)) return n; return null; };
    let found = null;
    try { found = tryNodes(freshDoc(doc).selection.nodes.toArray()); } catch (e) { /* ignore */ }
    if (!found && cache.selection) { try { found = tryNodes(cache.selection.nodes.toArray()); } catch (e) { /* ignore */ } }

    let everything = null;
    if (!found) { everything = allNodes(doc); found = tryNodes(everything); }

    if (!found) {
        // Same pixel size and same place on the page, and not one of our temp layers.
        const near = (a, b) => Math.abs(a - b) < 0.5;
        const matches = everything.filter(n => {
            try {
                if (isOurTemp(n) || !n.rasterInterface) return false;
                if (n.rasterWidth !== src.w || n.rasterHeight !== src.h) return false;
                const b = n.getSpreadBaseBox(), e = snap.spreadBox;
                return near(b.x, e.x) && near(b.y, e.y) && near(b.width, e.width) && near(b.height, e.height);
            } catch (e) { return false; }
        });
        if (matches.length >= 1) found = matches[0];
        if (!found && !cache.debugLogged) {
            cache.debugLogged = true;
            let sample = [];
            try { sample = everything.slice(0, 6).map(n => `${idOf(n)}:${descOf(n)}`); } catch (e) { /* ignore */ }
            console.log(`${TITLE}: original not found. wanted id ${snap.id}; scanned ${everything.length} nodes; sample ${sample.join(', ')}`);
        }
    }
    if (found) {
        cache.node = found;
        try { snap.id = idOf(found); } catch (e) { /* keep old id */ }
    }
    return found;
}

// Finds a node we created, by id or (fallback) by its label.
function findCreated(doc, id, label) {
    const everything = allNodes(doc);
    return everything.find(n => sameId(n, id)) ?? everything.find(n => descOf(n) === label) ?? null;
}

// Yes/OK from app.confirm, whatever form it returns.
function isYes(r) {
    if (typeof r === 'boolean') return r;
    const v = r?.value ?? r;
    return v === DialogResult.Ok?.value || v === DialogResult.Yes?.value || v === 1;
}

// Labels given to temporary layers, so leftovers can be found and removed.
const PREVIEW_LABEL = `${TITLE} preview`;
const LOADING_LABEL = `${TITLE} loading`;
// Invisible 1×1 stand-in used to push a stuck preview off the canvas. Not
// treated as a leftover (it's invisible), so it never triggers the cleanup prompt.
const BLANK_LABEL = `${TITLE} blank`;

// Remove previews using both the immediate and the queued command. Outside a
// dialog, Affinity doesn't always drop a preview with the immediate one alone.
function clearAllPreviews(doc) {
    try { doc.clearPreviews(); } catch (e) { /* ignore */ }
    try { doc.clearPreviewsAsync(() => {}); } catch (e) { /* ignore */ }
}

// Delete any preview/placeholder layer that Affinity kept as a real layer.
function findStrayPlaceholders(doc) {
    try { return allNodes(doc).filter(isOurTemp); } catch (e) { return []; }
}

// Removes leftover loading/preview layers, except ones in keepIds (temp layers
// the user chose to keep). A leftover is often not a real layer but a PREVIEW
// that Affinity never cleared: it shows in the Layers panel, yet a normal
// delete fails ("command failed"). So try several methods, re-checking after
// each, and report what happened: { found, removed, hidden, left, errors }.
// allowPreviews: false after the result has been placed. A preview command
// issued after a real command can undo that real command, so never do it then.
function removeStrayPlaceholders(doc, keepIds = new Set(), allowPreviews = true) {
    const remaining = () => findStrayPlaceholders(doc)
        .filter(n => { try { return !keepIds.has(idOf(n)); } catch (e) { return false; } });
    const found = remaining().length;
    const report = { found, removed: 0, hidden: 0, left: 0, errors: [] };
    if (!found) return report;

    const attempt = (what, fn) => {
        if (!remaining().length) return;
        try { fn(); } catch (e) { report.errors.push(`${what}: ${e?.message ?? e}`); }
    };
    // 1. It's a preview: clear previews.
    attempt('clear previews', () => clearAllPreviews(doc));
    // 2. Replace the stuck preview with an invisible one, then clear (replacing
    //    a preview works even when clearing alone doesn't).
    if (allowPreviews) attempt('replace preview', () => {
        const blank = { data: new Uint8Array(4), width: 1, height: 1 };
        doc.executeCommand(buildAddCommand(null, toBitmap(blank), Transform.createScale(1, 1), BLANK_LABEL), true);
        clearAllPreviews(doc);
    });
    // 3. It's a real layer: delete them all at once…
    attempt('delete', () => {
        doc.executeCommand(DocumentCommand.createDeleteSelection(Selection.create(freshDoc(doc), remaining()), true));
    });
    // Each command invalidates handles, so act on one layer at a time and look
    // it up fresh by id every time.
    const eachFresh = (what, act) => {
        const ids = remaining().map(n => { try { return idOf(n); } catch (e) { return null; } }).filter(Boolean);
        let ok = 0;
        for (const id of ids) {
            const n = remaining().find(m => sameId(m, id));
            if (!n) continue;
            try { act(n); ok++; } catch (e) { report.errors.push(`${what}: ${e?.message ?? e}`); }
        }
        return ok;
    };
    // 4. …or one at a time.
    attempt('delete one by one', () => {
        eachFresh('delete one', n => doc.executeCommand(DocumentCommand.createDeleteSelection(n.selfSelection, true)));
    });
    report.removed = found - remaining().length;
    // 5. Last resort: hide whatever is left so it isn't visible.
    report.hidden = eachFresh('hide', n => doc.executeCommand(DocumentCommand.createHideSelection(n.selfSelection)));
    report.left = remaining().length;
    return report;
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
    let parent = null;
    try { parent = node ? node.parent : null; } catch (e) { parent = null; }
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
    dlg.speed = opts.addComboBox('Speed', ['Fast (recommended)', 'Best quality (slow)'], 0);
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
        batch: SPEED_BATCH[dlg.speed.selectedIndex ?? 0] ?? SPEED_BATCH[0],
        keep: !!dlg.keep.value,
        preview: !!dlg.preview.value,
        quality: dlg.quality.selectedIndex ?? 0,
    };
}

// The settings that determine the full-quality result.
function renderKey(o) {
    return JSON.stringify([o.w, o.h, o.amount, o.order, o.batch]);
}

// ---------- main ----------

let hasRun = false;

function main() {
    if (hasRun) return;   // guards against both the host and the module body invoking main()
    hasRun = true;

    const doc = Document.current;
    if (!doc) { app.alert('Open a document first.', TITLE); return; }

    // Offer to clean up leftover placeholder/preview layers from an earlier run.
    const leftovers = findStrayPlaceholders(doc);
    const keepIds = new Set();   // leftovers the user chose to keep
    if (leftovers.length) {
        const msg = `Found ${leftovers.length} leftover "${TITLE}" loading/preview layer` +
            `${leftovers.length > 1 ? 's' : ''} from an earlier run.\n\nDelete ${leftovers.length > 1 ? 'them' : 'it'}?`;
        if (isYes(app.confirm(msg, TITLE))) {
            const r = removeStrayPlaceholders(doc);
            if (r.left) {
                app.alert(`Removed ${r.removed} of ${r.found}. ${r.left} couldn't be deleted` +
                    (r.hidden ? ` (${r.hidden} hidden instead)` : '') + '.\n\n' +
                    'Affinity is probably holding it as an old preview. Saving, closing and reopening ' +
                    'the document should clear it, because previews aren\'t saved.' +
                    (r.errors.length ? `\n\nDetails: ${r.errors.slice(0, 3).join('; ')}` : ''), TITLE);
            }
            if (r.errors.length) console.log(`${TITLE}: leftover cleanup: ${r.errors.join(' | ')}`);
        } else {
            for (const n of leftovers) { try { keepIds.add(idOf(n)); } catch (e) { /* ignore */ } }
        }
    }

    const node = freshDoc(doc).selection.firstNode;
    if (!node || !node.rasterInterface || isOurTemp(node)) {
        app.alert('Select a single pixel layer or image layer, then run this script again.', TITLE);
        return;
    }

    let src, snap;
    try {
        src = readPixels(node);
        snap = snapshotNode(node);
    } catch (e) {
        app.alert(`Couldn't read this layer's pixels:\n${e}`, TITLE);
        return;
    }
    // Use getNode() (never `node`) from here on: handles go stale after any command.
    // It returns null if the original has been moved out of reach or deleted.
    const cache = { node, selection: null };
    try { cache.selection = Selection.create(doc, [node]); } catch (e) { /* optional */ }
    const getNode = () => findOriginal(doc, cache, snap, src);

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
            steps: SeamCarve.carveSteps(src.data, src.w, src.h, o.w, o.h, { amount: o.amount, order: o.order, batch: o.batch }),
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
                    steps: SeamCarve.carveSteps(src.data, src.w, src.h, o.w, o.h, { amount: o.amount, order: o.order, batch: o.batch }) };
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
            const key = JSON.stringify([o.w, o.h, o.amount, o.order, o.quality]);
            if (key !== lastPreviewKey) {
                lastPreviewKey = key;
                const t0 = Date.now();
                const p = proxy(o.quality);
                const pw = Math.max(1, Math.round(o.w * p.s)), ph = Math.max(1, Math.round(o.h * p.s));
                const small = SeamCarve.carve(p.data, p.width, p.height, pw, ph,
                    { amount: o.amount, order: o.order, batch: PREVIEW_BATCH });
                const shown = composePreview(small, p.width, p.height);
                // Full-resolution size that the (possibly padded) preview bitmap stands for.
                const coverW = Math.max(o.w, src.w), coverH = Math.max(o.h, src.h);
                const xf = placementTransform(snap, src, coverW, coverH, shown.width, shown.height);
                const orig = getNode();
                doc.executeCommand(buildAddCommand(orig, toBitmap(shown), xf, PREVIEW_LABEL), true);
                if (!orig) previewNote = '  ·  (original layer not found; preview may be misplaced)';
                lastShown = shown;
                if (!previewNote) previewNote = `  ·  preview ${Date.now() - t0} ms`;
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

    // Removes the LOADING placeholder. Clearing previews alone isn't reliable
    // once the dialog has closed, but replacing a preview always works (that's
    // how the placeholder updates), so first swap it for an invisible 1×1
    // preview, then clear.
    let placeholderHidden = false;
    function hidePlaceholder() {
        placeholderHidden = true;
        try {
            const blank = { data: new Uint8Array(4), width: 1, height: 1 };   // fully transparent
            const xf = placementTransform(snap, src, 1, 1, 1, 1);
            doc.executeCommand(buildAddCommand(getNode(), toBitmap(blank), xf, BLANK_LABEL), true);
        } catch (e) { /* ignore */ }
        clearAllPreviews(doc);
    }

    const finish = () => {
        // 1. Take the placeholder down FIRST. This is the last preview command
        //    we ever send: a preview after a real command can undo it, which made
        //    the finished image vanish right after reaching 100%.
        hidePlaceholder();
        placeholderHidden = true;
        job = null;

        // 2. Place the real layer.
        let placed = null;
        try {
            placed = commit(doc, getNode, snap, src, o, me.result);
        } catch (e) {
            app.alert(`Couldn't place the new layer:\n${e?.message ?? e}`, TITLE);
        }

        // 3. Tidy up with real commands only (no previews from here on).
        try { removeStrayPlaceholders(doc, keepIds, false); } catch (e) { /* ignore */ }

        // 4. Failsafe: shortly after, make sure the new layer is still there and
        //    place it again if something removed it.
        if (placed) setTimeout(300, () => {
            try {
                if (findCreated(doc, placed.id, placed.label)) return;
                console.log(`${TITLE}: new layer disappeared after placing; placing it again.`);
                commit(doc, getNode, snap, src, o, me.result, true);
            } catch (e) {
                app.alert(`The new layer disappeared and couldn't be placed again:\n${e?.message ?? e}`, TITLE);
            }
        });
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
    let lastProgress = me.progress, lastProgressAt = Date.now();
    function drawPlaceholder() {
        if (placeholderHidden) return;
        try {
            const img = LoadingOverlay.render(base, phW, phH, me.progress);
            const xf = placementTransform(snap, src, coverW, coverH, img.width, img.height);
            doc.executeCommand(buildAddCommand(getNode(), toBitmap(img), xf, LOADING_LABEL), true);
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
            hidePlaceholder();
            job = null;
            app.alert(`Content-aware scaling failed:\n${e?.message ?? e}`, TITLE);
            return;
        }
        if (me.result) { finish(); return; }

        // Failsafe: if progress has stopped going up, take the placeholder down.
        // Rendering carries on and the image is still placed when it's ready.
        const now = Date.now();
        if (me.progress > lastProgress) { lastProgress = me.progress; lastProgressAt = now; }
        const limit = me.progress >= 1 ? STALL_AT_FULL_MS : STALL_MS;
        if (!placeholderHidden && now - lastProgressAt > limit) hidePlaceholder();

        if (now - lastDraw >= PLACEHOLDER_MS) drawPlaceholder();
        setTimeout(0, tick);
    }

    // Independent watchdog, in case the render ticks themselves stop running.
    function watchdog() {
        if (placeholderHidden || me.result) return;
        const limit = me.progress >= 1 ? STALL_AT_FULL_MS : STALL_MS;
        if (Date.now() - lastProgressAt > limit) { hidePlaceholder(); return; }
        setTimeout(500, watchdog);
    }

    drawPlaceholder();
    setTimeout(0, tick);
    setTimeout(500, watchdog);
}

// Add the full-quality layer as a sibling directly above the original, then
// hide (or delete) the original. Every command invalidates node handles, so
// nodes are looked up again after each step. If the original has been moved
// or deleted meanwhile, the new layer is still placed where the original was.
function commit(doc, getNode, snap, src, o, full, isRetry = false) {
    const expected = expectedSpreadBox(snap, src, o.w, o.h);
    const xf = placementTransform(snap, src, o.w, o.h, full.width, full.height);
    const label = `${TITLE} ${o.w}×${o.h}`;

    const before = new Set();
    for (const n of allNodes(doc)) { try { before.add(idOf(n)); } catch (e) { /* ignore */ } }
    const originalAtStart = getNode();
    doc.executeCommand(buildAddCommand(originalAtStart, toBitmap(full), xf, label));

    // Find the layer we just added.
    let newId = null;
    {
        const added = allNodes(doc).filter(n => { try { return !before.has(idOf(n)); } catch (e) { return false; } });
        const pick = added.find(n => descOf(n) === label) ?? added.find(n => !isOurTemp(n));
        if (pick) newId = idOf(pick);
    }
    const getNew = () => newId ? findCreated(doc, newId, label) : null;
    if (!getNew()) {
        app.alert('The new layer was created but could not be located to position it.', TITLE);
        return null;
    }

    const original = getNode();
    const notes = [];

    // Put it directly in front of the original, as a sibling (not a child).
    // Children run back to front, so "After" = in front.
    if (original) {
        try {
            const nn = getNew();
            const next = original.nextSibling;
            const alreadyThere = next && sameId(next, idOf(nn));
            if (!alreadyThere)
                doc.executeCommand(DocumentCommand.createMoveNodes(nn.selfSelection, getNode(), NodeMoveType.After));
        } catch (e) { notes.push(`Couldn't move the new layer next to the original (${e?.message ?? e}).`); }
    } else if (!isRetry) {
        notes.push('The original layer was moved or deleted while rendering, so the new layer was added ' +
                   'at the top of the layer stack, where the original used to be.');
    }

    // Safety net: if Affinity sized or placed the new layer differently than
    // expected, snap it onto the original's (remembered) position.
    if (snap.axisAligned) {
        try {
            const nn = getNew();
            const got = nn.getSpreadBaseBox();
            const off = Math.max(Math.abs(got.x - expected.x), Math.abs(got.y - expected.y),
                                 Math.abs(got.width - expected.width), Math.abs(got.height - expected.height));
            if (off > 0.5)
                doc.executeCommand(DocumentCommand.createTransform(nn.selfSelection, rectToRect(copyRect(got), expected)));
        } catch (e) { /* placement is best effort */ }
    }

    if (original) {
        try {
            const orig = getNode();
            doc.executeCommand(o.keep
                ? DocumentCommand.createHideSelection(orig.selfSelection)
                : DocumentCommand.createDeleteSelection(orig.selfSelection, true));
        } catch (e) { notes.push(`Couldn't ${o.keep ? 'hide' : 'delete'} the original layer (${e?.message ?? e}).`); }
    }

    try { doc.selection = [getNew()]; } catch (e) { /* selection is cosmetic */ }

    try {
        const nn = getNew(), orig = getNode();
        if (nn && orig && nn.parent && sameId(nn.parent, idOf(orig)))
            notes.push('Affinity placed the new layer inside the original. Drag it out in the Layers panel.');
    } catch (e) { /* ignore */ }

    if (notes.length) app.alert(notes.join('\n\n'), TITLE);
    try { newId = idOf(getNew()); } catch (e) { /* keep */ }
    return { id: newId, label };
}

module.exports.main = main;
main();
