/**
 * Client-side face-presence check for the enrollment 2x2 photo (Step1Requirements.tsx
 * only — NOT the shared DocUploadField component, which also carries payment-proof and
 * certificate uploads that must never be gated by this).
 *
 * Uses @vladmandic/face-api (an actively-maintained fork of the original, long-
 * unmaintained face-api.js) with the TinyFaceDetector model — the smallest/fastest of
 * the library's models, sufficient for a binary "is there a face" presence check since
 * this isn't identity matching. Runs entirely in the browser: no upload round-trip, no
 * new backend dependency, and no native Node build risk. Model weights are self-hosted
 * under /models (copied from the library's own bundled weights) rather than fetched
 * from a third-party CDN, so enrollment doesn't depend on an external host's uptime.
 */
import * as faceapi from '@vladmandic/face-api';

const MODEL_URL = '/models';

let loadPromise: Promise<void> | null = null;

function loadModel(): Promise<void> {
  if (!loadPromise) {
    loadPromise = faceapi.nets.tinyFaceDetector.loadFromUri(MODEL_URL).catch((err) => {
      loadPromise = null; // allow a retry on the next call instead of caching a permanent failure
      throw err;
    });
  }
  return loadPromise;
}

/** Resolves true if at least one face is detected in the given image data URL. */
export async function detectFaceInDataUrl(dataUrl: string): Promise<boolean> {
  await loadModel();

  const img = new Image();
  await new Promise<void>((resolve, reject) => {
    img.onload = () => resolve();
    img.onerror = () => reject(new Error('Could not load image for face detection.'));
    img.src = dataUrl;
  });

  const detection = await faceapi.detectSingleFace(img, new faceapi.TinyFaceDetectorOptions());
  return !!detection;
}
