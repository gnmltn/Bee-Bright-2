/**
 * Stamps every certificate file with a permanent, non-removable "OFFICIAL COPY OF BEE
 * BRIGHT" watermark before it's ever written to disk — certificateController.js's
 * saveCertificateFile() is the one and only place a certificate's bytes get persisted
 * (both the initial upload AND Replace go through it), so routing both image and PDF
 * paths through here means nothing can reach storage unwatermarked.
 *
 * Two different libraries for two different jobs, both newly added — this codebase's
 * existing `pdfkit` dependency can only ever GENERATE a brand-new PDF from scratch
 * (confirmed: used only for the Weekly Digest report and for converting an uploaded
 * image into a downloadable PDF) — it has no API to load and draw on top of an
 * EXISTING, already-authored PDF, which is exactly what an admin-uploaded certificate
 * is. `pdf-lib` is built specifically for that: load real PDF bytes, get each page,
 * draw directly onto it, save. For images, nothing in this codebase does any pixel-
 * level drawing/compositing at all yet (the "image processing" done so far — see
 * authController.js/enrollmentController.js's detectImageMime — is magic-byte
 * sniffing only, never manipulation) — `sharp` is the standard, actively-maintained
 * choice for Node, and its SVG-compositing support is what actually lets it draw
 * rotated, semi-transparent TEXT (sharp has no native "draw text" primitive of its
 * own; compositing a tiny SVG containing the text onto the image is the normal,
 * documented way to do this with sharp).
 */
const sharp = require('sharp');
const { PDFDocument, rgb, degrees, StandardFonts } = require('pdf-lib');

const WATERMARK_TEXT = 'OFFICIAL COPY OF BEE BRIGHT';
const WATERMARK_OPACITY = 0.1; // within the requested 8–12% range
const WATERMARK_ANGLE_DEGREES = -45;
const WATERMARK_COLOR_RGB = { r: 128, g: 128, b: 128 }; // light gray

function escapeXml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * Draws the watermark onto a raster image (PNG/JPEG) via an SVG overlay composited
 * on top — SVG's own `transform="rotate(angle cx cy)"` rotates around the text's
 * already-centered anchor, so (unlike the PDF path below) no extra trigonometry is
 * needed to keep it visually centered once rotated.
 */
async function watermarkImageBuffer(buf, mimetype) {
  const image = sharp(buf, { failOn: 'none' });
  const metadata = await image.metadata();
  const width = metadata.width || 0;
  const height = metadata.height || 0;
  if (!width || !height) {
    throw new Error('Could not read image dimensions to apply the watermark.');
  }

  const centerX = width / 2;
  const centerY = height / 2;
  // Scaled to the shorter side so the stamp reads clearly on a small certificate and
  // doesn't overflow a tall, narrow one.
  const fontSize = Math.max(14, Math.round(Math.min(width, height) * 0.09));

  const svg = `<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
    <text
      x="${centerX}" y="${centerY}"
      font-family="Helvetica, Arial, sans-serif"
      font-size="${fontSize}"
      font-weight="bold"
      fill="rgb(${WATERMARK_COLOR_RGB.r},${WATERMARK_COLOR_RGB.g},${WATERMARK_COLOR_RGB.b})"
      fill-opacity="${WATERMARK_OPACITY}"
      text-anchor="middle"
      dominant-baseline="central"
      transform="rotate(${WATERMARK_ANGLE_DEGREES} ${centerX} ${centerY})"
    >${escapeXml(WATERMARK_TEXT)}</text>
  </svg>`;

  const outputFormat = mimetype.includes('png') ? 'png' : 'jpeg';
  return image
    .composite([{ input: Buffer.from(svg), top: 0, left: 0 }])
    .toFormat(outputFormat)
    .toBuffer();
}

/**
 * Draws the watermark onto every page of an existing PDF. pdf-lib rotates text around
 * its OWN drawing origin (the baseline start), not around an arbitrary pivot the way
 * SVG does — so to land the text's visual CENTER on the page's true center once
 * rotated, the origin is offset by the rotated half-width/half-height vector first.
 */
async function watermarkPdfBuffer(buf) {
  const pdfDoc = await PDFDocument.load(buf);
  const font = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
  const angleRad = (WATERMARK_ANGLE_DEGREES * Math.PI) / 180;
  const cos = Math.cos(angleRad);
  const sin = Math.sin(angleRad);

  for (const page of pdfDoc.getPages()) {
    const { width, height } = page.getSize();
    const fontSize = Math.max(14, Math.round(Math.min(width, height) * 0.09));
    const textWidth = font.widthOfTextAtSize(WATERMARK_TEXT, fontSize);
    const halfW = textWidth / 2;
    const halfH = fontSize / 2;
    const centerX = width / 2;
    const centerY = height / 2;

    // Origin = center - R(angle) * (halfW, halfH) — see module doc comment above.
    const x = centerX - (halfW * cos - halfH * sin);
    const y = centerY - (halfW * sin + halfH * cos);

    page.drawText(WATERMARK_TEXT, {
      x,
      y,
      size: fontSize,
      font,
      color: rgb(WATERMARK_COLOR_RGB.r / 255, WATERMARK_COLOR_RGB.g / 255, WATERMARK_COLOR_RGB.b / 255),
      opacity: WATERMARK_OPACITY,
      rotate: degrees(WATERMARK_ANGLE_DEGREES),
    });
  }

  const bytes = await pdfDoc.save();
  return Buffer.from(bytes);
}

/** Single entry point saveCertificateFile() calls — dispatches on the already-
 *  validated mimetype, same values used throughout certificateController.js. */
async function applyCertificateWatermark(buf, mimetype) {
  if (mimetype === 'application/pdf') return watermarkPdfBuffer(buf);
  return watermarkImageBuffer(buf, mimetype);
}

module.exports = {
  WATERMARK_TEXT,
  WATERMARK_OPACITY,
  WATERMARK_ANGLE_DEGREES,
  applyCertificateWatermark,
  watermarkImageBuffer,
  watermarkPdfBuffer,
};
