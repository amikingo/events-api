import type { HolderFieldKey, HolderFields } from "../models/event.js";

/** Today's public form: name and mobile required, the rest optional (the default for new and existing events). */
export const DEFAULT_HOLDER_FIELDS: HolderFields = { name: "REQUIRED", mobile: "REQUIRED", email: "OPTIONAL", affiliation: "OPTIONAL", country: "OPTIONAL" };

/**
 * A DETAILED event's holder-field rules (Phase 7), as one pure check shared by the public form and checkout. Each
 * setting maps to the guest-profile fields it covers: name → first_name and last_name (the existing name
 * representation; first_name is the required part), mobile → phone, email, affiliation → affiliation_name, country.
 * - REQUIRED: the field must be given (for name: first_name).
 * - HIDDEN: the event doesn't collect it, so sending it is refused rather than silently stored.
 * - OPTIONAL: either way. But a holder's details live on a guest profile, which needs a first name: other details
 *   without one are refused (`required_with_details`); a holder with nothing at all is an unnamed ticket.
 */
export type HolderDetails = {
  first_name?: string | null | undefined;
  last_name?: string | null | undefined;
  phone?: string | null | undefined;
  email?: string | null | undefined;
  affiliation_name?: string | null | undefined;
  country?: string | null | undefined;
};

export type HolderFieldIssue = { path: string; message: string; code: "required" | "not_collected" | "required_with_details" };

const COVERS: Record<HolderFieldKey, ReadonlyArray<keyof HolderDetails>> = {
  name: ["first_name", "last_name"],
  mobile: ["phone"],
  email: ["email"],
  affiliation: ["affiliation_name"],
  country: ["country"],
};
const REQUIRED_PART: Record<HolderFieldKey, keyof HolderDetails> = {
  name: "first_name",
  mobile: "phone",
  email: "email",
  affiliation: "affiliation_name",
  country: "country",
};
const LABELS: Record<HolderFieldKey, string> = { name: "name", mobile: "mobile number", email: "email", affiliation: "organization or affiliation", country: "country" };

const given = (value: string | null | undefined): boolean => typeof value === "string" && value.trim() !== "";

/**
 * The problems with one holder's details, each with its request path under `pathPrefix` (e.g. "body" or
 * "body.items.0.holders.2"). `skip` leaves out fields another rule already covers (the legacy form's phone is the
 * buyer's delivery mobile, so the mobile setting doesn't apply to it).
 */
export function holderFieldIssues(
  fields: HolderFields,
  details: HolderDetails,
  pathPrefix: string,
  skip: ReadonlyArray<HolderFieldKey> = [],
): HolderFieldIssue[] {
  const issues: HolderFieldIssue[] = [];
  for (const key of Object.keys(COVERS) as HolderFieldKey[]) {
    if (skip.includes(key)) continue;
    const setting = fields[key];
    if (setting === "REQUIRED" && !given(details[REQUIRED_PART[key]])) {
      issues.push({ path: `${pathPrefix}.${REQUIRED_PART[key]}`, message: `This event needs each guest's ${LABELS[key]}`, code: "required" });
    }
    if (setting === "HIDDEN") {
      for (const column of COVERS[key]) {
        if (given(details[column])) {
          issues.push({ path: `${pathPrefix}.${column}`, message: `This event doesn't collect a guest's ${LABELS[key]}`, code: "not_collected" });
        }
      }
    }
  }
  const otherDetails = (["last_name", "phone", "email", "affiliation_name", "country"] as const).some((column) => given(details[column]));
  if (fields.name !== "REQUIRED" && !given(details.first_name) && otherDetails) {
    issues.push({ path: `${pathPrefix}.first_name`, message: "Give the guest's first name to record their other details", code: "required_with_details" });
  }
  return issues;
}

/** Whether a holder gave nothing at all (an unnamed ticket). */
export function isEmptyHolder(details: HolderDetails): boolean {
  return (["first_name", "last_name", "phone", "email", "affiliation_name", "country"] as const).every((column) => !given(details[column]));
}
