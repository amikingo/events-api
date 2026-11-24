import { Router } from "express";
import swaggerUi from "swagger-ui-express";
import { buildV1Document } from "../../openapi/v1.js";

/** Generated at startup from the same Zod contracts the routes validate with: it cannot drift. */
const document = buildV1Document();

export const docsRouter = Router();

docsRouter.get("/openapi.json", (_req, res) => {
  res.json(document);
});
docsRouter.use("/docs", swaggerUi.serve, swaggerUi.setup(document));
