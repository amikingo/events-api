import { sequelize } from "../db.js";

async function ping(): Promise<void> {
  await sequelize.query("SELECT 1");
}

export const healthRepository = { ping };
