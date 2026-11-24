import type { Response } from "express";

export type SuccessEnvelope<T> = { success: true; data: T; message?: string };
export type ListMeta = { count: number; page: number; pageSize: number };
export type ListEnvelope<T> = { success: true; data: T[]; meta: ListMeta; message?: string };
export type ErrorEnvelope = {
  success: false;
  error: { code: string; message: string; details?: unknown };
};

export function sendSuccess<T>(res: Response, statusCode: number, data: T, message?: string): void {
  const payload: SuccessEnvelope<T> = { success: true, data };
  if (message) payload.message = message;
  res.status(statusCode).json(payload);
}

export function sendList<T>(res: Response, statusCode: number, data: T[], meta: ListMeta, message?: string): void {
  const payload: ListEnvelope<T> = { success: true, data, meta };
  if (message) payload.message = message;
  res.status(statusCode).json(payload);
}

export function sendNoContent(res: Response): void {
  res.status(204).send();
}
