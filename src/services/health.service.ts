import { ServiceUnavailableError } from "../errors/app-errors.js";
import { healthRepository } from "../repositories/health.repository.js";
import { lifecycle } from "../utils/lifecycle.js";

async function checkReadiness(): Promise<{ status: "ready" }> {
  if (lifecycle.shuttingDown) throw new ServiceUnavailableError("Shutting down");
  try {
    await healthRepository.ping();
  } catch (error) {
    throw new ServiceUnavailableError("Database is not reachable", undefined, { cause: error });
  }
  return { status: "ready" };
}

export const healthService = { checkReadiness };
