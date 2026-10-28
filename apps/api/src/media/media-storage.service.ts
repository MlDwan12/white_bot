import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash, randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

export interface StoredFile {
  /** Path relative to the storage root — the absolute one differs per environment. */
  relativePath: string;
  sizeBytes: number;
}

/**
 * Owns the files on disk. Nothing else in the app builds a filesystem path, so
 * the storage layout stays changeable (and a future move to S3 touches this
 * file alone).
 *
 * Stored names are generated, never taken from the upload: a user-supplied
 * name can contain `../` or a null byte and would let an upload land outside
 * the storage root. The original name lives in the database instead, where it
 * is data rather than a path.
 */
/** Most filesystems cap a name at 255 bytes; 200 leaves room for multi-byte characters. */
const MAX_BASENAME_LENGTH = 200;

@Injectable()
export class MediaStorageService {
  private readonly root: string;

  constructor(config: ConfigService) {
    this.root = path.resolve(config.getOrThrow<string>('MEDIA_STORAGE_PATH'));
  }

  async write(buffer: Buffer, extension: string): Promise<StoredFile> {
    // Sharded by the first two characters so a few thousand files don't end up
    // in one directory, where listing gets slow on some filesystems.
    const id = randomUUID();
    const shard = id.slice(0, 2);
    const safeExtension = MediaStorageService.normalizeExtension(extension);
    const relativePath = path.join(shard, `${id}${safeExtension}`);
    const absolutePath = path.join(this.root, relativePath);

    await fs.mkdir(path.dirname(absolutePath), { recursive: true });
    await fs.writeFile(absolutePath, buffer);
    return { relativePath, sizeBytes: buffer.byteLength };
  }

  /** Absolute path for reading a stored file — guarded against escaping the root. */
  absolutePath(relativePath: string): string {
    const resolved = path.resolve(this.root, relativePath);
    const rootWithSep = this.root.endsWith(path.sep)
      ? this.root
      : this.root + path.sep;
    if (!resolved.startsWith(rootWithSep)) {
      // Only reachable if a stored path was tampered with in the database;
      // refusing is cheaper than explaining a file read outside the volume.
      throw new Error('Путь к файлу выходит за пределы хранилища');
    }
    return resolved;
  }

  async read(relativePath: string): Promise<Buffer> {
    return fs.readFile(this.absolutePath(relativePath));
  }

  /**
   * Runs `use` with a path whose *basename* is `filename`.
   *
   * Some uploaders take the displayed file name from the path they are given
   * (the MAX SDK does exactly this), and our stored names are generated uuids
   * — so handing over the storage path would show the recipient
   * "9f3a…-1b2c.pdf" instead of "Прайс-лист.pdf". A hard link costs no copy
   * and no extra disk; the copy is only a fallback for when the temp
   * directory sits on another filesystem.
   */
  async withNamedPath<T>(
    relativePath: string,
    filename: string,
    use: (namedPath: string) => Promise<T>,
  ): Promise<T> {
    const source = this.absolutePath(relativePath);
    const directory = await fs.mkdtemp(
      path.join(os.tmpdir(), 'white-bot-upload-'),
    );
    const namedPath = path.join(
      directory,
      MediaStorageService.safeBasename(filename, path.basename(relativePath)),
    );

    try {
      await fs
        .link(source, namedPath)
        .catch(() => fs.copyFile(source, namedPath));
      return await use(namedPath);
    } finally {
      await fs.rm(directory, { recursive: true, force: true }).catch(() => {
        // Nothing to do about a temp directory that won't go: it's in the OS
        // temp space and the upload itself already succeeded or failed.
      });
    }
  }

  /**
   * A file name safe to place in a directory we control: no separators, no
   * traversal, no control characters, and never empty.
   */
  static safeBasename(filename: string, fallback: string): string {
    const cleaned = path
      .basename(filename)
      // eslint-disable-next-line no-control-regex -- control characters are exactly what must go
      .replace(/[\u0000-\u001f/\\]/g, '')
      .trim();
    if (cleaned.length === 0 || cleaned === '.' || cleaned === '..') {
      return fallback;
    }
    return MediaStorageService.truncateKeepingExtension(cleaned);
  }

  /**
   * Shortens an over-long name without dropping its extension. Cutting the
   * tail would take the extension with it, leaving the recipient a file their
   * system can't open — the very problem the original name is preserved for.
   */
  private static truncateKeepingExtension(name: string): string {
    if (name.length <= MAX_BASENAME_LENGTH) {
      return name;
    }
    const extension = path.extname(name);
    // An "extension" that long isn't one; treat the whole thing as a stem.
    if (extension.length === 0 || extension.length > 12) {
      return name.slice(0, MAX_BASENAME_LENGTH);
    }
    const stem = name.slice(0, name.length - extension.length);
    return stem.slice(0, MAX_BASENAME_LENGTH - extension.length) + extension;
  }

  async remove(relativePath: string): Promise<void> {
    await fs.rm(this.absolutePath(relativePath), { force: true });
  }

  static checksum(buffer: Buffer): string {
    return createHash('sha256').update(buffer).digest('hex');
  }

  /**
   * Keeps only a short alphanumeric extension. The extension is cosmetic here
   * — the stored name is generated — but a value taken from user input has no
   * business reaching the filesystem unfiltered.
   */
  private static normalizeExtension(extension: string): string {
    const cleaned = extension.replace(/^\./, '').toLowerCase();
    return /^[a-z0-9]{1,8}$/.test(cleaned) ? `.${cleaned}` : '';
  }
}
