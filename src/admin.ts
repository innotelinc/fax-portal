/**
 * Who may change what in the admin console.
 *
 * Two rules, both about not locking the estate out of its own fax server:
 * an administrator cannot disable or demote themselves, and the last enabled
 * administrator cannot be demoted or disabled by anyone. Everything else an
 * administrator may do is a normal edit and leaves an audit row.
 */
export interface AccountRef {
  readonly uid: number;
  readonly email: string;
  readonly isAdmin: boolean;
  readonly enabled: boolean;
}

export type AccountChange = "enable" | "disable" | "grant-admin" | "revoke-admin";

export interface GuardResult {
  readonly allowed: boolean;
  readonly reason?: string;
}

export function canChangeAccount(
  actor: AccountRef,
  target: AccountRef,
  change: AccountChange,
  allAccounts: readonly AccountRef[],
): GuardResult {
  if (target.uid !== actor.uid) {
    // Editing someone else is fine, except when it would leave no admin behind.
    if ((change === "disable" || change === "revoke-admin") && target.isAdmin) {
      const enabledAdmins = allAccounts.filter((account) => account.isAdmin && account.enabled);
      const targetIsLastAdmin = enabledAdmins.length === 1 && enabledAdmins[0]?.uid === target.uid;
      if (targetIsLastAdmin) {
        return {
          allowed: false,
          reason: `${target.email} is the last enabled administrator; give someone else the role first`,
        };
      }
    }
    return { allowed: true };
  }

  switch (change) {
    case "disable":
      return { allowed: false, reason: "you cannot disable your own account" };
    case "revoke-admin":
      return { allowed: false, reason: "you cannot remove your own administrator role" };
    case "enable":
    case "grant-admin":
      return { allowed: true };
  }
}

export const CHANGE_LABEL: Record<AccountChange, string> = {
  enable: "enabled",
  disable: "disabled",
  "grant-admin": "granted administrator",
  "revoke-admin": "removed administrator",
};
