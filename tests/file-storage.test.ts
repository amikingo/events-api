import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileStorageClient } from "../src/clients/file-storage.client.js";
import { filesConfig } from "../src/config/files.js";
import { detectImageType } from "../src/utils/image-type.js";

/** Image detection by contents and the local storage client, against the temporary FILES_DIR from setup-env.ts. */
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from("rest of a png")]);
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46]);
const WEBP = Buffer.concat([Buffer.from("RIFF"), Buffer.from([0x24, 0x00, 0x00, 0x00]), Buffer.from("WEBPVP8 ")]);

test("an image is recognised by its first bytes, never by its name: JPEG, PNG and WebP only", () => {
  assert.deepEqual(detectImageType(JPEG), { contentType: "image/jpeg", extension: "jpg" });
  assert.deepEqual(detectImageType(PNG), { contentType: "image/png", extension: "png" });
  assert.deepEqual(detectImageType(WEBP), { contentType: "image/webp", extension: "webp" });

  assert.equal(detectImageType(Buffer.from("GIF89a......")), null, "GIF is not accepted");
  assert.equal(detectImageType(Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'/>")), null, "SVG is not accepted");
  assert.equal(detectImageType(Buffer.from("%PDF-1.7")), null);
  assert.equal(detectImageType(Buffer.concat([Buffer.from("RIFF"), Buffer.from([0, 0, 0, 0]), Buffer.from("WAVE")])), null, "RIFF but not WebP");
  assert.equal(detectImageType(PNG.subarray(0, 7)), null, "a cut-off signature");
  assert.equal(detectImageType(Buffer.alloc(0)), null);
});

test("the tests write to a temporary FILES_DIR, and URLs are paths under /assets/uploads", () => {
  assert.ok(filesConfig.rootDir.includes("events-api-files-"), `unexpected files folder ${filesConfig.rootDir}`);
  assert.equal(fileStorageClient.url("events/covers/a.png"), "/assets/uploads/events/covers/a.png");
});

test("save writes the file under its key (creating the folder), never overwrites, and delete removes it", async () => {
  const key = `events/covers/${randomUUID()}.png`;
  const path = join(filesConfig.rootDir, key);

  await fileStorageClient.save(key, PNG);
  assert.deepEqual(readFileSync(path), PNG);

  await assert.rejects(fileStorageClient.save(key, JPEG), (error: unknown) => (error as NodeJS.ErrnoException).code === "EEXIST");
  assert.deepEqual(readFileSync(path), PNG, "the first file is untouched");

  await fileStorageClient.delete(key);
  assert.equal(existsSync(path), false);
  await fileStorageClient.delete(key); // already gone: fine
});

test("a key that would leave the files folder is refused before anything is written", async () => {
  for (const key of ["../outside.png", "events/../../outside.png", "/etc/outside.png", ""]) {
    await assert.rejects(fileStorageClient.save(key, PNG), /inside the files folder/, JSON.stringify(key));
    await assert.rejects(fileStorageClient.delete(key), /inside the files folder/, JSON.stringify(key));
  }
});
