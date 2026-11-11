// Turns a picture from the camera or the photo library into three JPEG sizes.
//
// The picture is drawn onto a canvas, which also bakes in the way the phone was held, so a photo
// taken sideways is stored the right way up.

import { PHOTO } from './config.js';

const MAX_FILE_BYTES = 80 * 1024 * 1024;

function notAPicture() {
  const error = new Error('The phone could not read that picture.');
  error.code = 'unreadable';
  return error;
}

function decodeWithImageElement(blob) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const image = new Image();
    const release = () => URL.revokeObjectURL(url);
    image.onload = () => {
      if (!image.naturalWidth || !image.naturalHeight) {
        release();
        reject(notAPicture());
        return;
      }
      resolve({ source: image, width: image.naturalWidth, height: image.naturalHeight, close: release });
    };
    image.onerror = () => {
      release();
      reject(notAPicture());
    };
    image.src = url;
  });
}

async function decode(blob) {
  try {
    // An image element turns the picture the right way up on every current phone.
    return await decodeWithImageElement(blob);
  } catch (first) {
    if (typeof createImageBitmap !== 'function') throw first;
    let bitmap;
    try {
      bitmap = await createImageBitmap(blob, { imageOrientation: 'from-image' });
    } catch (second) {
      throw notAPicture();
    }
    return { source: bitmap, width: bitmap.width, height: bitmap.height, close: () => bitmap.close && bitmap.close() };
  }
}

function drawScaled(source, width, height, max) {
  const scale = Math.min(1, max / Math.max(width, height));
  const w = Math.max(1, Math.round(width * scale));
  const h = Math.max(1, Math.round(height * scale));
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('The phone is too low on memory to handle this picture.');
  // JPEG has no see-through areas, so anything transparent becomes white rather than black.
  context.fillStyle = '#ffffff';
  context.fillRect(0, 0, w, h);
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = 'high';
  context.drawImage(source, 0, 0, w, h);
  return canvas;
}

function toJpeg(canvas, quality) {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (!blob || !blob.size) {
          reject(new Error('The phone could not shrink this picture.'));
          return;
        }
        blob.arrayBuffer().then(resolve, reject);
      },
      'image/jpeg',
      quality,
    );
  });
}

const discard = (canvas) => {
  // Giving the canvas back straight away matters on iPhones, which allow only a small total.
  canvas.width = 0;
  canvas.height = 0;
};

/**
 * Returns { full, mid, thumb, w, h }. The three sizes are ArrayBuffers of JPEG data, and w and h
 * are the size of the full picture. Throws an Error with a plain message if the file is not a
 * picture the phone can read.
 */
export async function makeRenditions(file) {
  if (!file || !file.size) throw notAPicture();
  if (file.size > MAX_FILE_BYTES) throw new Error('That picture is too large for the app.');
  const decoded = await decode(file);
  const canvases = [];
  try {
    const full = drawScaled(decoded.source, decoded.width, decoded.height, PHOTO.full.max);
    canvases.push(full);
    // Each smaller size is drawn from the one before, which is quicker and looks smoother.
    const mid = drawScaled(full, full.width, full.height, PHOTO.mid.max);
    canvases.push(mid);
    const thumb = drawScaled(mid, mid.width, mid.height, PHOTO.thumb.max);
    canvases.push(thumb);
    return {
      full: await toJpeg(full, PHOTO.full.quality),
      mid: await toJpeg(mid, PHOTO.mid.quality),
      thumb: await toJpeg(thumb, PHOTO.thumb.quality),
      w: full.width,
      h: full.height,
    };
  } finally {
    decoded.close();
    canvases.forEach(discard);
  }
}

/** True when the bytes start like a JPEG file. */
export function looksLikeJpeg(buffer) {
  if (!buffer || buffer.byteLength < 4) return false;
  const bytes = new Uint8Array(buffer, 0, 3);
  return bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
}
