import type { Options } from "sequelize";
import { env } from "./env.js";

const ssl =
  env.POSTGRES_SSL === "disable" ? false : { rejectUnauthorized: env.POSTGRES_SSL === "verify-full" };

export const databaseConfig: Options = {
  dialect: "postgres",
  host: env.POSTGRES_HOST,
  port: env.POSTGRES_PORT,
  database: env.POSTGRES_DATABASE,
  username: env.POSTGRES_USER,
  password: env.POSTGRES_PASSWORD,
  dialectOptions: ssl ? { ssl } : {},
  pool: { max: env.POSTGRES_POOL_MAX, min: 0, idle: 10_000, acquire: 30_000 },
  logging: false,
  define: {
    freezeTableName: true,
    timestamps: true,
    createdAt: "created_at",
    updatedAt: "updated_at",
  },
};
