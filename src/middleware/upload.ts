import type { RequestHandler } from "express";
import multer from "multer";
import { filesConfig } from "../config/files.js";
import { PayloadTooLargeError, ValidationAppError } from "../errors/app-errors.js";

/**
 * Parses a cover upload: multipart/form-data with exactly one file in the field "file" and nothing else. Memory
 * storage only, so nothing touches the disk until the service has checked the file. Runs after authentication and
 * permission checks, so an unauthorized caller can never make the server buffer a file.
 */
const parseCover = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: filesConfig.coverMaxBytes, files: 1, fields: 0, parts: 1 },
}).single("file");

const UPLOAD_PROBLEMS: Record<string, string> = {
  LIMIT_PART_COUNT: "Send only the image, in the field 'file'",
  LIMIT_FILE_COUNT: "Send exactly one image",
  LIMIT_FIELD_COUNT: "Send only the image, with no other fields",
  LIMIT_UNEXPECTED_FILE: "Send the image in the field 'file'",
};

export const coverImageUpload: RequestHandler = (req, res, next) => {
  parseCover(req, res, (error: unknown) => {
    if (!error) {
      next();
      return;
    }
    if (error instanceof multer.MulterError) {
      if (error.code === "LIMIT_FILE_SIZE") {
        next(new PayloadTooLargeError(`The image must be ${filesConfig.coverMaxBytes / (1024 * 1024)} MB or smaller`));
        return;
      }
      const message = UPLOAD_PROBLEMS[error.code] ?? "The upload is not a single image in the field 'file'";
      next(new ValidationAppError("Request validation failed", { issues: [{ path: "body", message, code: error.code.toLowerCase() }] }));
      return;
    }
    // Memory storage cannot fail, so anything else is the parser refusing the body (missing boundary, cut-off form).
    next(
      new ValidationAppError(
        "Request validation failed",
        { issues: [{ path: "body", message: "The multipart/form-data body could not be read", code: "malformed_multipart" }] },
        { cause: error },
      ),
    );
  });
};
