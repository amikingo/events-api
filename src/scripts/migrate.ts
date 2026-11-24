import { writeFile } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import { sequelize } from "../db.js";
import { MIGRATIONS_DIR, migrator } from "../migrator.js";

/**
 * npm run db:migrate | db:migrate:undo [-- --to <name>|0] | db:migrate:status | db:migration:create -- --name <kebab-name>
 * Run as a one-off job (exactly one runner per deploy), never on application boot.
 */
const TEMPLATE = `import { DataTypes, type QueryInterface } from "sequelize";
import type { MigrationFn } from "umzug";

export const up: MigrationFn<QueryInterface> = async ({ context: queryInterface }) => {
  await queryInterface.sequelize.transaction(async (transaction) => {
    // createTable / addConstraint (named) / addIndex (named) / raw SQL -- always pass { transaction }
  });
};

export const down: MigrationFn<QueryInterface> = async ({ context: queryInterface }) => {
  await queryInterface.sequelize.transaction(async (transaction) => {
    // exact inverse of up()
  });
};
`;

function timestamp(date = new Date()): string {
  return date.toISOString().replace(/\D/g, "").slice(0, 14); // YYYYMMDDHHmmss (UTC)
}

async function main(): Promise<void> {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: { to: { type: "string" }, name: { type: "string" } },
  });

  switch (positionals[0]) {
    case "up": {
      const applied = await migrator.up(values.to ? { to: values.to } : {});
      console.log(JSON.stringify({ applied: applied.map((m) => m.name) }, null, 2));
      return;
    }
    case "down": {
      const to = values.to === "0" ? 0 : values.to;
      const reverted = await migrator.down(to === undefined ? {} : { to });
      console.log(JSON.stringify({ reverted: reverted.map((m) => m.name) }, null, 2));
      return;
    }
    case "status": {
      const [executed, pending] = await Promise.all([migrator.executed(), migrator.pending()]);
      console.log(JSON.stringify({ executed: executed.map((m) => m.name), pending: pending.map((m) => m.name) }, null, 2));
      return;
    }
    case "create": {
      if (!values.name || !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(values.name)) {
        throw new Error("create requires --name in kebab-case, e.g. --name create-app-invoice");
      }
      if (import.meta.filename.endsWith(".js")) throw new Error("Create migrations from the TypeScript sources");
      const file = path.join(MIGRATIONS_DIR, `${timestamp()}-${values.name}.ts`);
      await writeFile(file, TEMPLATE, { flag: "wx" });
      console.log(JSON.stringify({ created: path.relative(process.cwd(), file) }, null, 2));
      return;
    }
    default:
      throw new Error("Usage: migrate.ts up | down [--to <name>|0] | status | create --name <kebab-name>");
  }
}

try {
  await main();
} catch (error) {
  console.error(JSON.stringify({ success: false, error: error instanceof Error ? error.message : String(error) }, null, 2));
  process.exitCode = 1;
} finally {
  await sequelize.close();
}
