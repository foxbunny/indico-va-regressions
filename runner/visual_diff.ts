import pixelmatch from 'pixelmatch';
import {PNG} from 'pngjs';

export interface VisualDiffResult {
  diffImage: Buffer | null;
  pixelCount: number;
  pixelPct: number;
  unchanged: boolean;
  sizeMismatch: boolean;
}

// Copy an image into the top-left of a (w, h) RGBA buffer. The remainder is
// left as the buffer's initial fill — caller controls that.
function pasteIntoCanvas(src: PNG, canvas: Buffer, w: number): void {
  for (let y = 0; y < src.height; y++) {
    const srcStart = y * src.width * 4;
    const dstStart = y * w * 4;
    src.data.copy(canvas, dstStart, srcStart, srcStart + src.width * 4);
  }
}

export function compareImages(baseline: Buffer, actual: Buffer, threshold = 0.1): VisualDiffResult {
  const a = PNG.sync.read(baseline);
  const b = PNG.sync.read(actual);
  const sizeMismatch = a.width !== b.width || a.height !== b.height;
  const w = Math.max(a.width, b.width);
  const h = Math.max(a.height, b.height);
  const total = w * h;

  let aData: Buffer;
  let bData: Buffer;
  if (!sizeMismatch) {
    aData = a.data;
    bData = b.data;
  } else {
    // Pad both images to the common bounding box (top-left aligned). Padding
    // is opaque magenta so missing rows/columns are visibly flagged in the
    // diff overlay rather than reported as a 100%-changed image.
    const fillRgba = (buf: Buffer) => {
      for (let i = 0; i < buf.length; i += 4) {
        buf[i] = 255; buf[i + 1] = 0; buf[i + 2] = 255; buf[i + 3] = 255;
      }
    };
    aData = Buffer.alloc(total * 4);
    bData = Buffer.alloc(total * 4);
    fillRgba(aData);
    fillRgba(bData);
    pasteIntoCanvas(a, aData, w);
    pasteIntoCanvas(b, bData, w);
  }

  const diff = new PNG({width: w, height: h});
  const pixelCount = pixelmatch(aData, bData, diff.data, w, h, {
    threshold,
    includeAA: false,
  });
  if (pixelCount === 0) {
    return {diffImage: null, pixelCount: 0, pixelPct: 0, unchanged: true, sizeMismatch};
  }
  return {
    diffImage: PNG.sync.write(diff),
    pixelCount,
    pixelPct: (pixelCount / total) * 100,
    unchanged: false,
    sizeMismatch,
  };
}
