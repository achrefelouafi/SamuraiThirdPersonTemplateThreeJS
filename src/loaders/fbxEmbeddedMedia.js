/**
 * Recover the images embedded inside a binary FBX.
 *
 * FBX can carry its textures as raw blobs in `Video` nodes rather than as files
 * beside the model, which is what "embed textures" means on export. Three's
 * FBXLoader reads those blobs — but it decides their format from the *filename
 * extension*, and Blender writes them as `<model>.fbm\Image_16`, with no
 * extension at all. The check fails ("Image type "fbm\Image_16" is not
 * supported"), the loader falls back to fetching `./models/Image_16` as a file,
 * and every material ends up with a broken map on a body whose textures were in
 * the file the whole time.
 *
 * So the blobs are lifted out here instead and the format is read from the
 * magic bytes, which is the only reliable answer. `AssetLoader` registers the
 * result under the names the loader will ask for, and its URL modifier serves
 * them from memory.
 *
 * Only the path down to the images is parsed — top level → `Objects` → `Video`
 * — so the cost is a walk over the node headers, not a second parse of a
 * 20 MB file.
 */

const BINARY_MAGIC = 'Kaydara FBX Binary';
/** Header is 23 bytes, then a uint32 version. */
const HEADER_LENGTH = 27;
/** 7500 and up store node offsets and array lengths as 64-bit. */
const WIDE_VERSION = 7500;

/** Image formats identified by their leading bytes. */
const SIGNATURES = [
  { mime: 'image/png', bytes: [0x89, 0x50, 0x4e, 0x47] },
  { mime: 'image/jpeg', bytes: [0xff, 0xd8, 0xff] },
  { mime: 'image/webp', bytes: [0x52, 0x49, 0x46, 0x46] }, // RIFF….WEBP
  { mime: 'image/gif', bytes: [0x47, 0x49, 0x46, 0x38] },
  { mime: 'image/bmp', bytes: [0x42, 0x4d] }
];

function sniffMime(bytes) {
  for (const { mime, bytes: signature } of SIGNATURES) {
    if (signature.every((byte, index) => bytes[index] === byte)) return mime;
  }
  return null;
}

/** Last path segment of a Windows or POSIX path, lowercased. */
function basename(path) {
  return String(path).split(/[\\/]/).pop().toLowerCase();
}

class Reader {
  constructor(buffer) {
    this.view = new DataView(buffer);
    this.bytes = new Uint8Array(buffer);
    this.wide = this.view.getUint32(23, true) >= WIDE_VERSION;
  }

  /** Node header: end offset, property count, property block length, name. */
  header(offset) {
    const { view, wide } = this;
    const end = wide ? Number(view.getBigUint64(offset, true)) : view.getUint32(offset, true);
    const propertyCount = wide
      ? Number(view.getBigUint64(offset + 8, true))
      : view.getUint32(offset + 4, true);
    const propertyLength = wide
      ? Number(view.getBigUint64(offset + 16, true))
      : view.getUint32(offset + 8, true);

    let cursor = offset + (wide ? 24 : 12);
    const nameLength = view.getUint8(cursor);
    cursor += 1;
    const name = String.fromCharCode(...this.bytes.subarray(cursor, cursor + nameLength));
    cursor += nameLength;

    return { end, propertyCount, propertyLength, name, properties: cursor };
  }

  /** A node list ends with a null record, whose length varies with the width. */
  get sentinel() {
    return this.wide ? 25 : 13;
  }

  /**
   * Read a node's property list. Arrays are skipped rather than decoded —
   * nothing on the path to an image is one, and they are the expensive part.
   */
  properties(node) {
    const { view } = this;
    let cursor = node.properties;
    const values = [];

    for (let i = 0; i < node.propertyCount; i++) {
      const type = String.fromCharCode(view.getUint8(cursor));
      cursor += 1;

      switch (type) {
        case 'Y':
          values.push(view.getInt16(cursor, true));
          cursor += 2;
          break;
        case 'C':
          values.push(view.getUint8(cursor) !== 0);
          cursor += 1;
          break;
        case 'I':
          values.push(view.getInt32(cursor, true));
          cursor += 4;
          break;
        case 'F':
          values.push(view.getFloat32(cursor, true));
          cursor += 4;
          break;
        case 'D':
          values.push(view.getFloat64(cursor, true));
          cursor += 8;
          break;
        case 'L':
          values.push(Number(view.getBigInt64(cursor, true)));
          cursor += 8;
          break;
        case 'S':
        case 'R': {
          const length = view.getUint32(cursor, true);
          cursor += 4;
          const raw = this.bytes.subarray(cursor, cursor + length);
          // 'S' is text; 'R' is the image itself, kept as bytes.
          values.push(type === 'S' ? String.fromCharCode(...raw) : raw);
          cursor += length;
          break;
        }
        default: {
          // An array (f/d/l/b/i/c) or something unknown: the block length is
          // authoritative, so stop decoding and trust it.
          return { values, complete: false };
        }
      }
    }

    return { values, complete: true };
  }

  /** Immediate children of a node. */
  *children(node) {
    let cursor = node.properties + node.propertyLength;
    while (cursor < node.end - this.sentinel) {
      const child = this.header(cursor);
      if (!child.end) break;
      yield child;
      cursor = child.end;
    }
  }

  /** Top-level nodes. */
  *top() {
    let cursor = HEADER_LENGTH;
    while (cursor < this.bytes.length) {
      const node = this.header(cursor);
      if (!node.end) break;
      yield node;
      cursor = node.end;
    }
  }
}

/**
 * Every embedded image in an FBX, as object URLs keyed by the names a loader
 * might ask for them under.
 *
 * The keys are lowercased and cover both what the FBX calls the image and the
 * bare filename the loader falls back to: a `Video` named `Image_0.003` with
 * `RelativeFilename` `tpose.fbm\Image_0_003` is registered under
 * `image_0.003`, `image_0_003` and the basename — whichever the request comes
 * in as, it resolves.
 *
 * @param {ArrayBuffer} buffer the raw FBX
 * @returns {Map<string, string>} name → object URL. Empty for ASCII FBX and for
 *   files that embed nothing; the caller falls back to loading files as usual.
 */
export function extractEmbeddedMedia(buffer) {
  const media = new Map();
  if (!buffer || buffer.byteLength < HEADER_LENGTH) return media;

  const head = String.fromCharCode(...new Uint8Array(buffer, 0, BINARY_MAGIC.length));
  if (head !== BINARY_MAGIC) return media; // ASCII FBX: nothing embedded to find

  let reader;
  try {
    reader = new Reader(buffer);
  } catch {
    return media;
  }

  try {
    for (const node of reader.top()) {
      if (node.name !== 'Objects') continue;

      for (const child of reader.children(node)) {
        if (child.name !== 'Video') continue;

        let content = null;
        let filename = '';
        for (const property of reader.children(child)) {
          if (property.name === 'Content') {
            const { values } = reader.properties(property);
            if (values[0] instanceof Uint8Array) content = values[0];
          } else if (property.name === 'RelativeFilename' || property.name === 'Filename') {
            const { values } = reader.properties(property);
            if (!filename && typeof values[0] === 'string') filename = values[0];
          }
        }

        if (!content || content.length < 4) continue; // a reference, not a blob

        const mime = sniffMime(content);
        if (!mime) continue;

        const url = URL.createObjectURL(new Blob([content], { type: mime }));

        // FBX packs "Name\0\1Video" into the node's second property.
        const { values } = reader.properties(child);
        const label = typeof values[1] === 'string' ? values[1].split('\0')[0] : '';

        for (const key of [label, label.replace(/\./g, '_'), basename(filename)]) {
          if (key) media.set(key.toLowerCase(), url);
        }
      }
    }
  } catch (error) {
    console.warn('[fbxEmbeddedMedia] could not read embedded images', error);
  }

  return media;
}
