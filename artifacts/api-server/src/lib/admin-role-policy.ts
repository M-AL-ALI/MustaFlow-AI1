import type { StaffRole } from "@workspace/db";

export type StaffRoleMutationDecision =
  | { allowed: true }
  | { allowed: false; code: "admin_last_owner_required"; message: string };

export function decideStaffRoleChange(
  previousRole: string | null,
  nextRole: StaffRole,
  databaseOwnerCount: number,
): StaffRoleMutationDecision {
  if (previousRole === "owner" && nextRole !== "owner" && databaseOwnerCount <= 1) {
    return {
      allowed: false,
      code: "admin_last_owner_required",
      message: "The last Owner cannot be changed. Add another Owner first.",
    };
  }
  return { allowed: true };
}

export function decideStaffRemoval(
  previousRole: string,
  databaseOwnerCount: number,
): StaffRoleMutationDecision {
  if (previousRole === "owner" && databaseOwnerCount <= 1) {
    return {
      allowed: false,
      code: "admin_last_owner_required",
      message: "The last Owner cannot be removed. Add another Owner first.",
    };
  }
  return { allowed: true };
}
