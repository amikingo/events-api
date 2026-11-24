import path from "node:path";
import { pathToFileURL } from "node:url";
import type { QueryInterface } from "sequelize";
import { SequelizeStorage, Umzug, type MigrationFn } from "umzug";
import { sequelize } from "./db.js";

type MigrationModule = { up: MigrationFn<QueryInterface>; down?: MigrationFn<QueryInterface> };

export const MIGRATIONS_DIR = path.resolve(import.meta.dirname, "migrations");

/**
 * Umzug replaces sequelize-cli. Works from src/ (tsx, .ts files) and dist/ (node, .js files).
 * Migration names are recorded as "<file>.js" in SequelizeMeta either way; otherwise a
 * database migrated from source would look entirely pending to the compiled build.
 */
export const migrator = new Umzug<QueryInterface>({
  migrations: {
    glob: ["*.{ts,js}", { cwd: MIGRATIONS_DIR, ignore: ["*.d.ts"] }],
    resolve: ({ name, path: filePath, context }) => {
      if (!filePath) throw new Error(`Migration ${name} has no file path`);
      const storedName = name.replace(/\.ts$/, ".js");
      const load = async () => (await import(pathToFileURL(filePath).href)) as MigrationModule;
      return {
        name: storedName,
        path: filePath,
        up: async () => (await load()).up({ name: storedName, path: filePath, context }),
        down: async () => {
          const migration = await load();
          if (!migration.down) throw new Error(`Migration ${storedName} has no down()`);
          return migration.down({ name: storedName, path: filePath, context });
        },
      };
    },
  },
  context: sequelize.getQueryInterface(),
  storage: new SequelizeStorage({ sequelize }), // same SequelizeMeta table sequelize-cli uses
  logger: undefined,
});
