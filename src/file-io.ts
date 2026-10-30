/**
 * The only module that writes files. Every write is atomic (a temp file in the
 * same folder, then a rename), and a file that existed is copied to a backup
 * first.
 */
import { randomBytes } from 'node:crypto';
import { constants, copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';

/** The file's text, or null when it does not exist. */
export function readTextIfExists(file: string): string | null {
  if (!existsSync(file)) return null;
  if (!statSync(file).isFile()) throw new Error(`${file} is not a file`);
  return readFileSync(file, 'utf8');
}

/** Copies `file` to `<file>.bak`, or to `<file>.<timestamp>.bak` when that name is taken. Returns the backup path. */
export function backupFile(file: string): string {
  const plain = `${file}.bak`;
  const stamp = new Date().toISOString().replaceAll(/[-:]/g, '').replace(/\..*$/, '');
  for (const candidate of [plain, `${file}.${stamp}.bak`, `${file}.${stamp}-${randomBytes(3).toString('hex')}.bak`]) {
    if (existsSync(candidate)) continue;
    copyFileSync(file, candidate, constants.COPYFILE_EXCL);
    return candidate;
  }
  throw new Error(`No free backup name next to ${file}`);
}

/** Writes `text` to `file` through a temp file and a rename. Keeps the mode of an existing file. */
export function writeAtomic(opts: { file: string; text: string }): void {
  const dir = path.dirname(opts.file);
  mkdirSync(dir, { recursive: true });
  const mode = existsSync(opts.file) ? statSync(opts.file).mode & 0o777 : 0o644;
  const temp = path.join(dir, `.${path.basename(opts.file)}.agentbuffs-${process.pid}-${randomBytes(4).toString('hex')}.tmp`);
  try {
    writeFileSync(temp, opts.text, { encoding: 'utf8', mode, flag: 'wx' });
    renameSync(temp, opts.file);
  } catch (error) {
    rmSync(temp, { force: true });
    throw error;
  }
}
