import { Op, type WhereOptions } from "sequelize";
import type { PersonRow } from "../models/person.js";

/** Escapes LIKE wildcards so a search for "50%" matches the text, not everything. */
function likePattern(text: string): string {
  return `%${text.replace(/[\\%_]/g, (character) => `\\${character}`)}%`;
}

/**
 * Staff search over a guest profile's names, email and phone (case-insensitive, substring). Shared by the profile
 * search and the guest list. `phoneVariant` is the normalized form of the search text when it is an Ethiopian
 * mobile, so "0911…" also finds "+251911…".
 */
export function personSearchWhere(q: string, phoneVariant: string | null): WhereOptions<PersonRow> {
  const pattern = likePattern(q);
  return {
    [Op.or]: [
      { first_name: { [Op.iLike]: pattern } },
      { last_name: { [Op.iLike]: pattern } },
      { email: { [Op.iLike]: pattern } },
      { phone: { [Op.iLike]: pattern } },
      ...(phoneVariant ? [{ phone: phoneVariant }] : []),
    ],
  };
}
