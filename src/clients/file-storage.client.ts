import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";
import { filesConfig } from "../config/files.js";

/**
 * Where uploaded files are stored, behind three calls so a bucket can be added later without touching event code.
 * Today: local disk in FILES_DIR (a mounted volume in production), served publicly at /assets/uploads/...
 * Keys are relative, posix-style paths such as "events/covers/<uuid>.png".
 */
export type StorageProvider = "local";
export const STORAGE_PROVIDER: StorageProvider = "local";

/** Resolves a key inside FILES_DIR; a key that would escape it (e.g. "../x") is refused. */
function pathFor(key: string): string {
  const target = resolve(filesConfig.rootDir, key);
  if (!target.startsWith(`${filesConfig.rootDir}${sep}`)) throw new Error("File key must stay inside the files folder");
  return target;
}

/** Writes a new file; never overwrites an existing one. Creates the purpose subfolder when needed. */
async function save(key: string, bytes: Buffer): Promise<void> {
  const target = pathFor(key);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, bytes, { flag: "wx" });
}

/** Deletes a file; a file that is already gone is fine. */
async function remove(key: string): Promise<void> {
  await rm(pathFor(key), { force: true });
}

/** The public URL path the API serves the file at (express.static on filesConfig.publicPath). */
function url(key: string): string {
  return `${filesConfig.publicPath}/${key}`;
}

export const fileStorageClient = { save, delete: remove, url };
