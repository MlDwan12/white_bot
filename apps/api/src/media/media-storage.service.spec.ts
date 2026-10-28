import { ConfigService } from '@nestjs/config';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { MediaStorageService } from './media-storage.service';

async function setup() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'media-test-'));
  const config = { getOrThrow: () => root } as unknown as ConfigService;
  return { storage: new MediaStorageService(config), root };
}

describe('MediaStorageService', () => {
  it('stores bytes verbatim under a generated name', async () => {
    const { storage, root } = await setup();
    const bytes = Buffer.from('содержимое файла');

    const stored = await storage.write(bytes, 'txt');

    expect(await fs.readFile(path.join(root, stored.relativePath))).toEqual(
      bytes,
    );
    expect(stored.sizeBytes).toBe(bytes.byteLength);
  });

  it('never lets an upload name decide where the file lands', async () => {
    const { storage } = await setup();

    const stored = await storage.write(Buffer.from('x'), '../../etc/passwd');

    // The extension is the only part taken from user input; anything that
    // isn't a short alphanumeric suffix is dropped rather than sanitised
    // halfway.
    expect(stored.relativePath).not.toContain('..');
    expect(path.extname(stored.relativePath)).toBe('');
  });

  it('gives each file its own path', async () => {
    const { storage } = await setup();

    const first = await storage.write(Buffer.from('a'), 'png');
    const second = await storage.write(Buffer.from('a'), 'png');

    expect(first.relativePath).not.toBe(second.relativePath);
  });

  it('refuses to read outside the storage root', async () => {
    const { storage } = await setup();

    // Only reachable if a stored path were tampered with in the database, but
    // a path traversal must fail loudly rather than serve /etc/passwd.
    expect(() => storage.absolutePath('../../../etc/passwd')).toThrow(
      /выходит за пределы/,
    );
  });

  it('round-trips through read', async () => {
    const { storage } = await setup();
    const bytes = Buffer.from([0, 1, 2, 250, 255]);

    const stored = await storage.write(bytes, 'bin');

    expect(await storage.read(stored.relativePath)).toEqual(bytes);
  });

  describe('withNamedPath', () => {
    it('exposes the bytes under their original name, then cleans up', async () => {
      const { storage } = await setup();
      const bytes = Buffer.from('документ');
      const stored = await storage.write(bytes, 'txt');

      let seen = '';
      let directory = '';
      await storage.withNamedPath(
        stored.relativePath,
        'Прайс-лист.pdf',
        async (namedPath) => {
          // This basename is what an uploader shows the recipient; the stored
          // name is a generated uuid and would be meaningless to them.
          seen = path.basename(namedPath);
          directory = path.dirname(namedPath);
          expect(await fs.readFile(namedPath)).toEqual(bytes);
        },
      );

      expect(seen).toBe('Прайс-лист.pdf');
      await expect(fs.access(directory)).rejects.toThrow();
    });

    it('cleans up even when the upload fails', async () => {
      const { storage } = await setup();
      const stored = await storage.write(Buffer.from('x'), 'txt');

      let directory = '';
      await expect(
        storage.withNamedPath(stored.relativePath, 'a.txt', (namedPath) => {
          directory = path.dirname(namedPath);
          return Promise.reject(new Error('загрузка не удалась'));
        }),
      ).rejects.toThrow();

      await expect(fs.access(directory)).rejects.toThrow();
    });
  });

  describe('safeBasename', () => {
    it('strips a traversal attempt down to its last segment', () => {
      expect(MediaStorageService.safeBasename('../../etc/passwd', 'f')).toBe(
        'passwd',
      );
    });

    it('removes control characters, which have no place in a file name', () => {
      expect(
        MediaStorageService.safeBasename(
          `a${String.fromCharCode(0)}b.pdf`,
          'f',
        ),
      ).toBe('ab.pdf');
    });

    it.each(['   ', '.', '..', '/'])(
      'falls back rather than produce %p',
      (name) => {
        expect(MediaStorageService.safeBasename(name, 'fallback')).toBe(
          'fallback',
        );
      },
    );

    it('keeps the extension when shortening an over-long name', () => {
      const name = 'о'.repeat(250) + '.pdf';

      const result = MediaStorageService.safeBasename(name, 'f');

      // Cutting the tail would take the extension with it and leave the
      // recipient a file their system cannot open.
      expect(result.endsWith('.pdf')).toBe(true);
      expect(result.length).toBeLessThanOrEqual(200);
    });

    it('treats an absurdly long suffix as part of the name, not an extension', () => {
      const name = 'x'.repeat(250) + '.' + 'y'.repeat(50);

      const result = MediaStorageService.safeBasename(name, 'f');

      expect(result.length).toBeLessThanOrEqual(200);
    });

    it('keeps an ordinary name untouched', () => {
      expect(MediaStorageService.safeBasename('Отчёт 2026.xlsx', 'f')).toBe(
        'Отчёт 2026.xlsx',
      );
    });
  });

  it('computes a stable sha256 of the original bytes', () => {
    const checksum = MediaStorageService.checksum(Buffer.from('abc'));

    expect(checksum).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });
});
