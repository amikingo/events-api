import type { AssignmentRow } from "../repositories/user-role.repository.js";
import type { IdentityProfile } from "../services/auth-token.service.js";
import type { NavigationNode } from "../services/permission-resolution.service.js";
import type { PermissionMatrix } from "../utils/rbac.js";

/**
 * Pure response shaping for the staff session contract consumed by the web app.
 * No queries, no authorization, no HTTP. Changing a field here is an API change.
 */
export type AssignmentSummaryDto = {
  id: string;
  organization_id: string | null;
  branch_id: string | null;
  role: { id: string; code: string; name: string };
  organization: { id: string; name: string } | null;
  branch: { id: string; code: string; name: string } | null;
};

export type StaffTokenDto = {
  accessToken: string;
  tokenType: "Bearer";
  expiresIn: number;
  user: { id: string } & IdentityProfile;
  assignment: AssignmentSummaryDto;
  assignments: AssignmentSummaryDto[];
};

export type StaffSessionDto = {
  user: { id: string } & IdentityProfile;
  assignment: AssignmentSummaryDto;
  assignments: AssignmentSummaryDto[];
  permissions: Record<string, PermissionMatrix>;
  navigation: NavigationNode[];
};

export function toAssignmentSummaryDto(assignment: AssignmentRow): AssignmentSummaryDto {
  return {
    id: assignment.id,
    organization_id: assignment.organization_id,
    branch_id: assignment.branch_id,
    role: { id: assignment.role.id, code: assignment.role.code, name: assignment.role.name },
    organization: assignment.organization ? { id: assignment.organization.id, name: assignment.organization.name } : null,
    branch: assignment.branch
      ? { id: assignment.branch.id, code: assignment.branch.code, name: assignment.branch.name }
      : null,
  };
}

export function toStaffTokenDto(input: {
  token: string;
  expiresIn: number;
  userId: string;
  profile: IdentityProfile;
  assignment: AssignmentRow;
  assignments: AssignmentRow[];
}): StaffTokenDto {
  return {
    accessToken: input.token,
    tokenType: "Bearer",
    expiresIn: input.expiresIn,
    user: { id: input.userId, ...input.profile },
    assignment: toAssignmentSummaryDto(input.assignment),
    assignments: input.assignments.map(toAssignmentSummaryDto),
  };
}

export function toStaffSessionDto(input: {
  userId: string;
  profile: IdentityProfile;
  assignment: AssignmentRow;
  assignments: AssignmentRow[];
  permissions: Record<string, PermissionMatrix>;
  navigation: NavigationNode[];
}): StaffSessionDto {
  return {
    user: { id: input.userId, ...input.profile },
    assignment: toAssignmentSummaryDto(input.assignment),
    assignments: input.assignments.map(toAssignmentSummaryDto),
    permissions: input.permissions,
    navigation: input.navigation,
  };
}
