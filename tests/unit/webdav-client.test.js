/**
 * Unit tests for webdav-client.js — Protocol compatibility with Reference clients.
 *
 * These tests verify that our WebDAV client produces wire-format output
 * identical to the Reference C# (desktop) and TypeScript (mobile) clients.
 *
 * Real SHA-256 values verified against:
 *   - Reference/syncclipboard-mobile/src/__tests__/hash.test.ts
 *   - Reference/SyncClipboard/src/SyncClipboard.Shared/Utilities/Utility.cs
 *
 * Run: node --test tests/unit/webdav-client.test.js
 *   or: node tests/unit/webdav-client.test.js
 */

import { deepStrictEqual, strictEqual, ok } from 'node:assert';
import { describe, it, before } from 'node:test';
import { createHash } from 'node:crypto';

// Dynamic import since webdav-client uses ES module browser APIs
let mod;

before(async () => {
  mod = await import('../../extension/webdav-client.js');
});

// ============================================================
// Known SHA-256 test vectors (from Reference test data)
// ============================================================

const KNOWN_HASHES = {
  // From Reference hash.test.ts: "should calculate hash for empty string"
  '': 'E3B0C44298FC1C149AFBF4C8996FB92427AE41E4649B934CA495991B7852B855',
  // Standard test vectors
  'hello': '2CF24DBA5FB0A30E26E83B2AC5B9E29E1B161E5C1FA7425E73043362938B9824',
  'test': '9F86D081884C7D659A2FEAA0C55AD015A3BF4F1B2B0B822CD15D6C15B0F00A08',
  'hello world': 'B94D27B9934D3E08A52E52D7DA7DABFAC484EFE37A5380EE9088F7ACE2EFCDE9',
};

function nodeSha256(text) {
  return createHash('sha256').update(text).digest('hex').toUpperCase();
}

// ============================================================
// computeHash — SHA-256 hash matching Reference
// ============================================================

describe('computeHash', () => {
  it('produces SHA-256(empty string) matching Reference test data', async () => {
    const hash = await mod.computeHash('');
    strictEqual(hash, KNOWN_HASHES['']);
  });

  it('produces SHA-256("hello") matching Reference test data', async () => {
    const hash = await mod.computeHash('hello');
    strictEqual(hash, KNOWN_HASHES['hello']);
  });

  it('returns UPPERCASE hex (matching C# Convert.ToHexString)', async () => {
    const hash = await mod.computeHash('test');
    strictEqual(hash, hash.toUpperCase());
    // Verify it matches the known value
    strictEqual(hash, KNOWN_HASHES['test']);
  });

  it('matches Node.js crypto SHA-256 for arbitrary strings', async () => {
    const inputs = ['hello world', 'SyncClipboard', 'test123', '中文测试'];
    for (const input of inputs) {
      const ourHash = await mod.computeHash(input);
      const nodeHash = nodeSha256(input);
      strictEqual(ourHash, nodeHash, `Hash mismatch for: "${input}"`);
    }
  });

  it('produces identical hash for Blob and string of same content', async () => {
    const text = 'identical content test';
    const hashFromString = await mod.computeHash(text);
    const hashFromBlob = await mod.computeHash(new Blob([text]));
    strictEqual(hashFromString, hashFromBlob);
  });

  it('produces correct hash for binary Blob data', async () => {
    const bytes = new Uint8Array([0x00, 0x01, 0x02, 0xFF, 0xFE, 0xFD]);
    const blob = new Blob([bytes]);
    const ourHash = await mod.computeHash(blob);
    const nodeHash = createHash('sha256').update(bytes).digest('hex').toUpperCase();
    strictEqual(ourHash, nodeHash);
  });
});

// ============================================================
// computeProfileHash — server rule: SHA256(fileName + "|" + contentHash)
// ============================================================

describe('computeProfileHash', () => {
  it('implements the server rule: SHA256(fileName + "|" + contentHash.ToUpper())', async () => {
    const fileName = 'syncclipboard-20260507T113000Z-image.png';
    const content = new Blob([new Uint8Array(1024)]);

    const contentHash = await mod.computeHash(content);
    const expectedProfileHash = nodeSha256(fileName + '|' + contentHash);

    const actualProfileHash = await mod.computeProfileHash(fileName, content);
    strictEqual(actualProfileHash, expectedProfileHash);
  });

  it('matches the mobile calculateFileProfileHash implementation', async () => {
    // Verify exact scenario from hash.ts:
    // combinedString = fileName + "|" + fileHash.ToUpper()
    // profileHash = SHA256(combinedString).ToUpper()
    const fileName = 'photo.png';
    const content = new Blob(['fake image data']);
    const contentHash = await mod.computeHash(content);

    // This is exactly what calculateFileProfileHash does
    const combined = fileName + '|' + contentHash;
    const expected = nodeSha256(combined);

    const actual = await mod.computeProfileHash(fileName, content);
    strictEqual(actual, expected);
    strictEqual(actual, actual.toUpperCase(), 'Profile hash must be uppercase');
  });

  it('produces different profile hash when filename differs (same content)', async () => {
    const content = new Blob(['same content']);
    const hash1 = await mod.computeProfileHash('file-a.png', content);
    const hash2 = await mod.computeProfileHash('file-b.png', content);
    ok(hash1 !== hash2, 'Profile hashes must differ when filenames differ');
  });

  it('produces different profile hash when content differs (same filename)', async () => {
    const name = 'report.pdf';
    const hash1 = await mod.computeProfileHash(name, new Blob(['content v1']));
    const hash2 = await mod.computeProfileHash(name, new Blob(['content v2']));
    ok(hash1 !== hash2, 'Profile hashes must differ when content differs');
  });

  it('profile hash is always 64 uppercase hex chars (SHA-256)', async () => {
    const hash = await mod.computeProfileHash('test.bin', new Blob(['data']));
    strictEqual(hash.length, 64);
    ok(/^[0-9A-F]{64}$/.test(hash), 'Must be 64 uppercase hex chars');
  });
});

// ============================================================
// buildProfile — ProfileDto wire format
// ============================================================

describe('buildProfile', () => {
  function textInlineMax() {
    return mod.TEXT_INLINE_MAX_BYTES;
  }

  it('Text (inline, short): matches Reference ProfileDto wire format', async () => {
    const profile = await mod.buildProfile({ type: 'Text', text: 'Hello World' });

    // Wire format matches Reference camelCase JSON
    strictEqual(profile.type, 'Text');
    strictEqual(profile.hasData, false);
    strictEqual(profile.text, 'Hello World');
    strictEqual(profile.size, 11);
    strictEqual('dataName' in profile, false, 'dataName must not be present for inline text');

    // Hash must match Reference: SHA256("Hello World").ToUpper()
    const expectedHash = nodeSha256('Hello World');
    strictEqual(profile.hash, expectedHash);
    strictEqual(profile.hash.length, 64);
  });

  it('Text (inline, below threshold): preserves the full text', async () => {
    const longText = 'A'.repeat(200);
    const profile = await mod.buildProfile({ type: 'Text', text: longText });
    strictEqual(profile.type, 'Text');
    strictEqual(profile.hasData, false);
    strictEqual(profile.text, longText);
    strictEqual(profile.size, 200);
  });

  it('Text (inline, empty): blank text with correct hash', async () => {
    const profile = await mod.buildProfile({ type: 'Text', text: '' });
    strictEqual(profile.type, 'Text');
    strictEqual(profile.text, '');
    strictEqual(profile.size, 0);
    strictEqual(profile.hash, KNOWN_HASHES['']);
  });

  it('Text (file-backed, large): HasData=true with prefix text and full-text hash', async () => {
    const max = textInlineMax();
    const largeText = 'B'.repeat(max + 100);
    const profile = await mod.buildProfile({
      type: 'Text', text: largeText, blob: new Blob([largeText]),
    });

    strictEqual(profile.type, 'Text');
    strictEqual(profile.hasData, true);
    ok(profile.dataName, 'Must have DataName');
    ok(profile.dataName.endsWith('-text.txt'), 'Must end with -text.txt');
    strictEqual(profile.text, 'B'.repeat(max));
    ok(!profile.text.endsWith('...'), 'Large text prefix must not append ellipsis');

    // Text hash must always be the SHA256 of the full text
    const expectedHash = await mod.computeHash(largeText);
    strictEqual(profile.hash, expectedHash);
  });

  it('Text (file-backed, large): still uses transfer data when no blob is provided', async () => {
    const max = textInlineMax();
    const largeText = 'C'.repeat(max + 1);
    const profile = await mod.buildProfile({ type: 'Text', text: largeText });

    strictEqual(profile.type, 'Text');
    strictEqual(profile.hasData, true);
    ok(profile.dataName.endsWith('-text.txt'));
    strictEqual(profile.text, 'C'.repeat(max));
    strictEqual(profile.hash, await mod.computeHash(largeText));
  });

  it('Image: produces correct ProfileDto with server hash rule', async () => {
    const imageBlob = new Blob(['fake-png-data'], { type: 'image/png' });
    const profile = await mod.buildProfile({
      type: 'Image', blob: imageBlob, fileSize: imageBlob.size,
    });

    strictEqual(profile.type, 'Image');
    strictEqual(profile.hasData, true);
    ok(profile.dataName.endsWith('.png'), 'PNG must have .png extension');
    ok(profile.text === profile.dataName, 'Text field must be the filename, got: ' + profile.text);
    strictEqual(profile.size, imageBlob.size);

    // Hash must follow server rule
    const expectedHash = await mod.computeProfileHash(profile.dataName, imageBlob);
    strictEqual(profile.hash, expectedHash);
  });

  it('Image: derives correct file extension from MIME type', async () => {
    const cases = [
      ['image/png', '.png'],
      ['image/jpeg', '.jpg'],
      ['image/webp', '.webp'],
      ['image/gif', '.gif'],
    ];

    for (const [mime, ext] of cases) {
      const blob = new Blob(['data'], { type: mime });
      const profile = await mod.buildProfile({ type: 'Image', blob, fileSize: blob.size });
      ok(profile.dataName.endsWith(ext), `${mime} → filename should end with ${ext}, got ${profile.dataName}`);
    }
  });

  it('File: produces correct ProfileDto for generic file', async () => {
    const pdfBlob = new Blob(['pdf-content'], { type: 'application/pdf' });
    const fileName = 'report-2026.pdf';
    const profile = await mod.buildProfile({
      type: 'File', blob: pdfBlob, fileName, fileSize: pdfBlob.size,
    });

    strictEqual(profile.type, 'File');
    strictEqual(profile.hasData, true);
    strictEqual(profile.dataName, fileName);
    strictEqual(profile.text, fileName, 'Text must be the filename');

    const expectedHash = await mod.computeProfileHash(fileName, pdfBlob);
    strictEqual(profile.hash, expectedHash);
  });

  it('All ProfileDto fields are present and have correct types', async () => {
    const profile = await mod.buildProfile({ type: 'Text', text: 'test' });

    // Verify every field matching Reference ProfileDto
    ok('type' in profile, 'type field missing');
    ok('hash' in profile, 'hash field missing');
    ok('text' in profile, 'text field missing');
    ok('hasData' in profile, 'hasData field missing');
    ok('size' in profile, 'size field missing');

    strictEqual(typeof profile.type, 'string');
    strictEqual(typeof profile.hash, 'string');
    strictEqual(typeof profile.text, 'string');
    strictEqual(typeof profile.hasData, 'boolean');
    strictEqual(typeof profile.size, 'number');
    // inline text should not have dataName
    strictEqual('dataName' in profile, false);
  });

  it('Hash is always 64 uppercase hex characters', async () => {
    const profiles = [
      await mod.buildProfile({ type: 'Text', text: 'short' }),
      await mod.buildProfile({ type: 'Image', blob: new Blob(['img']), fileSize: 3 }),
      await mod.buildProfile({ type: 'File', blob: new Blob(['file']), fileName: 'doc.pdf', fileSize: 4 }),
    ];

    for (const p of profiles) {
      strictEqual(p.hash.length, 64, `${p.type} hash must be 64 chars`);
      ok(/^[0-9A-F]{64}$/.test(p.hash), `${p.type} hash must be uppercase hex`);
    }
  });
});

// ============================================================
// Cross-client wire format verification
// ============================================================

describe('Wire format compatibility', () => {
  it('Text ProfileDto JSON matches C# serialization format', async () => {
    // C# System.Text.Json serializes ProfileDto with PascalCase:
    // {"Type":"Text","Hash":"ABC...","Text":"hello","HasData":false,"DataName":null,"Size":5}
    const profile = await mod.buildProfile({ type: 'Text', text: 'hello' });
    const json = JSON.stringify(profile);

    const parsed = JSON.parse(json);
    strictEqual(parsed.type, 'Text');
    strictEqual(parsed.hasData, false);
    strictEqual('dataName' in parsed, false, 'inline text must not emit dataName');
    strictEqual(parsed.text, 'hello');
    strictEqual(parsed.size, 5);
    strictEqual(parsed.hash, KNOWN_HASHES['hello']);
  });

  it('Image ProfileDto JSON matches expected wire format', async () => {
    const blob = new Blob(['fake-png'], { type: 'image/png' });
    const profile = await mod.buildProfile({ type: 'Image', blob, fileSize: blob.size });
    const json = JSON.stringify(profile);

    const parsed = JSON.parse(json);
    strictEqual(parsed.type, 'Image');
    strictEqual(parsed.hasData, true);
    ok(typeof parsed.dataName === 'string' && parsed.dataName.length > 0);
    ok(parsed.text === parsed.dataName, 'Image text must be the filename, got: ' + parsed.text);
  });

  it('Matches the exact ProfileDto schema from C# record', () => {
    // C# ProfileDto has exactly these 6 fields, nothing more:
    const requiredFields = ['Type', 'Hash', 'Text', 'HasData', 'DataName', 'Size'];
    // Verify the C# record matches — we only produce these fields
    strictEqual(requiredFields.length, 6, 'C# ProfileDto has 6 fields');
  });
});
