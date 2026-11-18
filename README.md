# Content-Aware Scale for Affinity

Photoshop-style **content-aware scaling** for Affinity, written as an Affinity script.
Squash or stretch a pixel layer or image layer to any size. Important content keeps its
proportions, and the less interesting areas (sky, walls, background) absorb the change.

It uses seam carving: it removes or duplicates the lowest-energy paths of pixels,
the same family of technique behind Photoshop's Content-Aware Scale.

## Requirements

- Affinity **3.3 or later** (the version with the Scripting studio).
- Scripting turned on in Affinity's settings (**Enable Affinity Scripting**).

## Install

1. Open the **Scripting** studio in Affinity.
2. In the **Scripts Library**, click **Add Category** if you don't have one yet (for example, "My Plugins").
3. Choose **New Script…** in that category and name it `Content-Aware Scale`.
4. Copy the whole of [`dist/ContentAwareScale.js`](dist/ContentAwareScale.js), paste it into the Script Editor, and save.
5. Optional: right-click the script and choose **Mark as Trusted**, so it runs without a warning each time.

To update, paste the new `dist/ContentAwareScale.js` over the old script and save.

## Use

1. Select **one** pixel layer or image layer.
2. Run the script.
3. Set the new size with the **Width / Height** fields (pixels) or **Width % / Height %**.
   Each field has a popup slider, and the pixel and percentage fields stay linked.
4. As you change the size:
   - a quick low-resolution **live preview** appears on the canvas, and
   - the full-quality image is generated in the background, with progress shown at the bottom of the dialog.
5. Click **OK**.
   - If the dialog already says *Done*, the new layer is placed straight away.
   - If not, a **LOADING nn%** placeholder shows on the canvas until the image is ready.

**Cancel** leaves your layer untouched.

The result is a new, separate layer directly above the original. It keeps the original's
position, rotation and pixel density. The original is hidden, or deleted if you untick
**Keep original**.

### Options

| Option             | What it does |
|--------------------|--------------|
| Width / Height     | New size in pixels, from 1 px up to 4× the original. |
| Width % / Height % | The same size as a percentage, linked to the pixel fields. |
| Amount             | 100% = fully content-aware. Lower values blend in ordinary scaling, like Photoshop's Amount slider. |
| Seam order         | *Auto* does the larger change first. Try *Width first* or *Height first* if a result looks off. |
| Speed              | *Fast (recommended)* finds many seams per pass over the image, about 7–8× faster, and looked the same in testing. *Best quality* finds one seam at a time, the exact method. |
| Keep original      | On: hide the original layer. Off: delete it. |
| Live preview       | Show the low-res preview on the canvas while you edit. |
| Preview quality    | Fast (300 px), Balanced (600 px) or Detailed (1000 px) on the long edge. The preview is an approximation, so the final image can differ slightly in fine detail. |

## Tips and limits

- **Speed.** In *Fast* mode, a 1200×675 photo resizes in about half a second, and removing 400 columns
  from 1600×1067 takes under a second. *Best quality* takes about 3 s and 6 s for the same jobs.
  Rendering starts while the dialog is open, so it's often done by the time you click OK.
- **Flat colour.** Large areas of a single solid colour, like logos or vector-style art, count as
  "empty", so they get squeezed first. This happens in Photoshop too. Real photos, which have
  texture, behave much better.
- **Protecting areas.** The algorithm supports a protect mask, but the dialog doesn't offer
  one yet.
- **Rotated or skewed layers** are placed using their bounding box.
- While the LOADING placeholder is showing, don't move or delete the original layer. The new
  layer is placed relative to it.

## How it works

- `src/seamcarve.js`: forward-energy seam carving (Rubinstein, Shamir & Avidan, 2008) in plain
  JavaScript. Shrinking removes the cheapest connected seams. Enlarging finds the k cheapest seams
  and duplicates them, in passes of at most 50% so that seams aren't reused. In *Fast* mode, each pass
  over the image traces back from the cheapest end points and keeps every seam that doesn't share a pixel
  with one already chosen, taking up to 1% of the width at once. The work is a generator that yields after
  every seam, so it can run in small slices while Affinity stays responsive.
- `src/loading-overlay.js`: draws the LOADING placeholder (a small pixel font and a progress bar)
  into an image, because scripts can't draw text on the canvas directly.
- `src/affinity-main.js`: the Affinity side. It reads the layer's pixels, builds the dialog and live
  preview, runs the background render on timers, and places the new layer.

## Develop

```
src/seamcarve.js        seam carving engine (no Affinity dependencies)
src/loading-overlay.js  LOADING placeholder image (no Affinity dependencies)
src/affinity-main.js    Affinity scripting side
build.js                bundles src/ into dist/ContentAwareScale.js
test/test.js            tests for the engine and overlay (writes sample PNGs to test/out/)
```

You need [Node.js](https://nodejs.org/). Then:

```
node build.js        # rebuild dist/ContentAwareScale.js after editing src/
node test/test.js    # run the tests
```

The Affinity scripting SDK ships with the app as readable JavaScript in
`Affinity.app/Contents/Resources/JSLib/`, with examples in `JSLib/examples/`.

## License

[GPL-3.0](LICENSE)
