import type { RequestContract } from "../middleware/validate.js";
import { organizationIdParamsSchema, uuidSchema } from "./common.js";

export const roleParamsSchema = organizationIdParamsSchema.extend({ roleId: uuidSchema });

// One contract per endpoint (see middleware/validate.ts).
export const listRolesRequest = { params: organizationIdParamsSchema } satisfies RequestContract;

export const getRoleRequest = { params: roleParamsSchema } satisfies RequestContract;
