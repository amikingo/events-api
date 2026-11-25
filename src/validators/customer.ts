import type { RequestContract } from "../middleware/validate.js";

/** My Tickets takes nothing: who is asking comes only from the guest's access token. */
export const listMyTicketsRequest = {} satisfies RequestContract;
