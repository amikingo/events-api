import { resolve } from "node:path";
import { env } from "./env.js";

/** The bookings_api rule (app/config/paths.js): FILES_DIR, else /assets/uploads. Never a folder inside the app. */
export const DEFAULT_FILES_DIR = "/assets/uploads";

export const filesConfig = Object.freeze({
  /** Absolute folder on disk (a mounted volume in production). */
  rootDir: resolve(env.FILES_DIR ?? DEFAULT_FILES_DIR),
  /** Public URL prefix the API serves that folder at (express.static). */
  publicPath: "/assets/uploads",
  /** Event covers: JPEG, PNG or WebP up to 5 MB, stored under events/covers/. */
  coverMaxBytes: 5 * 1024 * 1024,
  coverFolder: "events/covers",
  /** Ticket design pictures: the same formats and size limit as covers. */
  ticketFolder: "events/tickets",
});
