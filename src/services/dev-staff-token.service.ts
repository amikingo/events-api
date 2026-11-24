import type { Env } from "../config/env.js";
import { StaffAssignmentNotFoundError, StaffContextRequiredError } from "../errors/app-errors.js";
import { toAssignmentSummaryDto, type AssignmentSummaryDto } from "../mappers/staff-session.mapper.js";
import { userRoleRepository, type AssignmentRow } from "../repositories/user-role.repository.js";
import { authTokenService } from "./auth-token.service.js";
import { isAssignmentUsable } from "./permission-resolution.service.js";

export type DevelopmentStaffToken = { accessToken: string; expiresIn: number; assignment: AssignmentSummaryDto };

/**
 * DEVELOPMENT ONLY. Signs a normal staff access token (same lifetime and checks as after a real login) for
 * one of the person's usable assignments, so staff screens and the Phase 2 demo work without auth-cheche.
 * Login, refresh and logout still need auth-cheche. The caller passes the environment (the script passes
 * env.NODE_ENV), which keeps this testable.
 */
async function issueDevelopmentStaffToken(input: {
  userId: string;
  assignmentId?: string | undefined;
  environment: Env["NODE_ENV"];
}): Promise<DevelopmentStaffToken> {
  if (input.environment !== "development") {
    throw new Error("dev:staff-token runs only when NODE_ENV=development");
  }

  const assignments = (await userRoleRepository.listActiveAssignmentsByUser(input.userId)).filter(isAssignmentUsable);
  let assignment: AssignmentRow | undefined;
  if (input.assignmentId !== undefined) {
    assignment = assignments.find((item) => item.id === input.assignmentId);
    if (!assignment) throw new StaffAssignmentNotFoundError("That assignment does not exist, is inactive, or belongs to someone else");
  } else if (assignments.length === 1) {
    assignment = assignments[0];
  } else if (assignments.length > 1) {
    throw new StaffContextRequiredError("This person has several assignments; pass --assignment-id", {
      assignmentIds: assignments.map((item) => item.id),
    });
  }
  if (!assignment) throw new StaffAssignmentNotFoundError("This person has no active assignment; run assign:staff first");

  const { token, expiresIn } = authTokenService.signAppStaffToken({
    userId: input.userId,
    assignment,
    profile: { mobile: null, firstname: null, middlename: null, lastname: null },
  });
  return { accessToken: token, expiresIn, assignment: toAssignmentSummaryDto(assignment) };
}

export const devStaffTokenService = { issueDevelopmentStaffToken };
