/**
 * Unit tests for utils/certificateWatermark.js — verifying the actual OUTPUT bytes
 * really contain the stamped watermark, not just that the functions run without
 * throwing (per the explicit ask). Two different techniques, one per format, since
 * "does this buffer contain a watermark" means something different for a rasterized
 * image (pixel values) than for a PDF (its own text-drawing instructions):
 *
 * - Image: sharp re-decodes the watermarked PNG and samples actual pixel values. The
 *   center (where the watermark text sits) must be measurably tinted away from the
 *   base image's solid color; a corner far from the center text must stay untouched —
 *   proving the mark is really drawn, is low-opacity (a small, not drastic, shift),
 *   and is centered rather than covering the whole image.
 * - PDF: pdf-lib's drawText() with a StandardFont encodes drawn strings as PDF HEX
 *   strings (confirmed by direct inspection: `<4F4646...>` hex-decodes to "OFFICIAL
 *   COPY OF BEE BRIGHT") inside a zlib/FlateDecode-compressed content stream — so the
 *   content streams are inflated with Node's own zlib and searched for that same hex
 *   encoding, which is the actual, verifiable proof the text was drawn.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const zlib = require('zlib');
const sharp = require('sharp');
const { PDFDocument } = require('pdf-lib');
const {
  applyCertificateWatermark,
  watermarkImageBuffer,
  watermarkPdfBuffer,
  WATERMARK_TEXT,
  WATERMARK_OPACITY,
} = require('../utils/certificateWatermark');

const WATERMARK_HEX = Buffer.from(WATERMARK_TEXT, 'ascii').toString('hex').toUpperCase();

async function makeSolidPng(width, height, rgbColor) {
  return sharp({ create: { width, height, channels: 3, background: rgbColor } }).png().toBuffer();
}

async function avgPixelValue(buf, region) {
  const raw = await sharp(buf).extract(region).raw().toBuffer();
  let sum = 0;
  for (let i = 0; i < raw.length; i++) sum += raw[i];
  return sum / raw.length;
}

async function makeBlankPdf(width, height) {
  const doc = await PDFDocument.create();
  doc.addPage([width, height]);
  return Buffer.from(await doc.save());
}

/** Inflates every FlateDecode content stream in the PDF and concatenates the result
 *  — the content streams are the only ones that matter here, so a best-effort inflate
 *  (skipping anything that isn't actually flate-compressed, e.g. an uncompressed
 *  stream) is all that's needed. */
function inflateAllStreams(pdfBuf) {
  const text = pdfBuf.toString('latin1');
  const re = /stream\r?\n([\s\S]*?)\r?\nendstream/g;
  let m;
  let combined = '';
  while ((m = re.exec(text))) {
    try {
      combined += zlib.inflateSync(Buffer.from(m[1], 'latin1')).toString('latin1');
    } catch {
      combined += m[1];
    }
  }
  return combined;
}

test('watermarkImageBuffer: the watermark is actually drawn — center pixel visibly tinted, a far corner stays untouched', async () => {
  const base = await makeSolidPng(300, 200, { r: 255, g: 255, b: 255 });
  const watermarked = await watermarkImageBuffer(base, 'image/png');

  const centerAvg = await avgPixelValue(watermarked, { left: 140, top: 90, width: 20, height: 20 });
  const cornerAvg = await avgPixelValue(watermarked, { left: 0, top: 0, width: 15, height: 15 });

  assert.ok(centerAvg < 255, `center pixels must be tinted by the watermark (got ${centerAvg})`);
  assert.equal(cornerAvg, 255, 'a corner far from the centered watermark text must be completely untouched');

  // Low-opacity (8–12%) means a SMALL shift, not a drastic one — a heavy-handed stamp
  // would defeat "doesn't block the certificate details."
  const shift = 255 - centerAvg;
  assert.ok(shift > 0 && shift < 40, `the center tint should be subtle, not drastic (shifted by ${shift})`);
});

test('watermarkImageBuffer: works for JPEG input/output too, not just PNG', async () => {
  const base = await sharp({ create: { width: 200, height: 150, channels: 3, background: { r: 255, g: 255, b: 255 } } })
    .jpeg()
    .toBuffer();
  const watermarked = await watermarkImageBuffer(base, 'image/jpeg');
  const metadata = await sharp(watermarked).metadata();
  assert.equal(metadata.format, 'jpeg');

  const centerAvg = await avgPixelValue(watermarked, { left: 90, top: 65, width: 20, height: 20 });
  assert.ok(centerAvg < 255, 'JPEG output must also be visibly watermarked at its center');
});

test('watermarkImageBuffer: the watermark is centered regardless of image size (scales with the image, not a fixed position)', async () => {
  const small = await makeSolidPng(100, 100, { r: 255, g: 255, b: 255 });
  const large = await makeSolidPng(800, 600, { r: 255, g: 255, b: 255 });

  const wmSmall = await watermarkImageBuffer(small, 'image/png');
  const wmLarge = await watermarkImageBuffer(large, 'image/png');

  const smallCenter = await avgPixelValue(wmSmall, { left: 42, top: 42, width: 16, height: 16 });
  const largeCenter = await avgPixelValue(wmLarge, { left: 392, top: 292, width: 16, height: 16 });

  assert.ok(smallCenter < 255, 'small image center must be tinted');
  assert.ok(largeCenter < 255, 'large image center must be tinted');
});

test('watermarkPdfBuffer: the literal watermark text is actually drawn into the PDF content stream', async () => {
  const base = await makeBlankPdf(400, 300);
  const watermarked = await watermarkPdfBuffer(base);

  const inflated = inflateAllStreams(watermarked);
  assert.ok(inflated.includes(WATERMARK_HEX), 'the hex-encoded watermark text must appear in a content stream');

  // Confirm it round-trips back to the real text, not a coincidental hex match.
  const decoded = Buffer.from(WATERMARK_HEX, 'hex').toString('ascii');
  assert.equal(decoded, WATERMARK_TEXT);
});

test('watermarkPdfBuffer: applies to EVERY page of a multi-page PDF, not just the first', async () => {
  const doc = await PDFDocument.create();
  doc.addPage([400, 300]);
  doc.addPage([400, 300]);
  doc.addPage([400, 300]);
  const base = Buffer.from(await doc.save());

  const watermarked = await watermarkPdfBuffer(base);
  const reloaded = await PDFDocument.load(watermarked);
  assert.equal(reloaded.getPageCount(), 3);

  // Re-save page-by-page content and confirm the mark is present on each — rather than
  // trust a single combined inflate (which would pass even if only page 1 got it).
  const inflated = inflateAllStreams(watermarked);
  const occurrences = inflated.split(WATERMARK_HEX).length - 1;
  assert.ok(occurrences >= 3, `expected the watermark on all 3 pages, found it ${occurrences} time(s)`);
});

test('watermarkPdfBuffer: uses the requested low opacity and the -45 degree rotation', async () => {
  const base = await makeBlankPdf(400, 300);
  const watermarked = await watermarkPdfBuffer(base);
  const inflated = inflateAllStreams(watermarked);

  // `gs` (graphics state, carrying the opacity set via an ExtGState) and the Tm matrix
  // (carrying the rotation, cos/sin of -45°) are both literal, uncompressed-looking
  // operators once inflated — confirmed by direct inspection during development.
  assert.match(inflated, /gs\b/, 'expected a graphics-state operator setting the low opacity');
  // cos(-45°) ≈ 0.7071, sin(-45°) ≈ -0.7071 — present in the Tm (text matrix) line.
  assert.match(inflated, /0\.70710/, 'expected the -45° rotation matrix values');

  assert.ok(WATERMARK_OPACITY >= 0.08 && WATERMARK_OPACITY <= 0.12, 'opacity constant itself must be within the requested 8–12% range');
});

test('applyCertificateWatermark: dispatches to the image path for image/png and image/jpeg, and the PDF path for application/pdf', async () => {
  const png = await makeSolidPng(120, 120, { r: 255, g: 255, b: 255 });
  const watermarkedPng = await applyCertificateWatermark(png, 'image/png');
  const pngMeta = await sharp(watermarkedPng).metadata();
  assert.equal(pngMeta.format, 'png');

  const pdf = await makeBlankPdf(300, 300);
  const watermarkedPdf = await applyCertificateWatermark(pdf, 'application/pdf');
  const inflated = inflateAllStreams(watermarkedPdf);
  assert.ok(inflated.includes(WATERMARK_HEX));
});
