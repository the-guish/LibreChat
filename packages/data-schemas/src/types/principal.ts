/**
 * What principal resolution reads of a user (their role and external identity), and the tenant
 * that holds them (absent for a platform-level user).
 */
export interface PrincipalUser {
  id: string;
  role?: string;
  idOnTheSource?: string | null;
  tenantId?: string;
}
