import { config } from '../config';
import { getSetting } from './settings';
import { reportingApp } from './graph';

// ── Microsoft Graph capability packs (app-by-app consent) ────────────────────────
// Microsoft's /adminconsent endpoint grants EVERY application permission configured on
// an app registration — you cannot consent to a subset via the link. So each capability
// is its OWN app registration in Lumen's Entra: consenting to that app == consenting to
// exactly that capability's scopes, nothing more. The baseline read-only "reporting" pack
// is the default (what customers normally see); each WRITE pack is a separate app that is
// only ever configured + consented deliberately, per customer, when a job needs it.
//
// Adding a new capability:
//   1. Register a new app in Lumen's Entra with ONLY the scopes below (Application perms).
//   2. Add redirect https://portal.lumenmsp.co.uk/auth/callback; create a secret.
//   3. Paste the client id + secret into Settings → Integrations → Additional write access.
//   4. Per customer, click "Request consent" — sends their admin the minimal, honest screen.

export interface Capability {
  key: string;
  label: string;
  description: string;
  access: 'read' | 'write';
  scopes: string[];   // Graph application permissions this pack's app should hold
  appKey: string;     // 'reporting' → the read-only reporting app; else a settings group name
}

export const CAPABILITIES: Capability[] = [
  {
    key: 'reporting', label: 'Reporting (read-only)', access: 'read', appKey: 'reporting',
    description: 'Intune device compliance, Microsoft Secure Score, service health and directory read — the default customer consent. No write access.',
    scopes: ['DeviceManagementManagedDevices.Read.All', 'SecurityEvents.Read.All', 'Directory.Read.All', 'ServiceHealth.Read.All'],
  },
  {
    key: 'intune_write', label: 'Device management (write)', access: 'write', appKey: 'graph_intune_write',
    description: 'Push Intune configuration and trigger device actions (sync, restart, remote wipe).',
    scopes: ['DeviceManagementManagedDevices.ReadWrite.All', 'DeviceManagementConfiguration.ReadWrite.All'],
  },
  {
    key: 'user_write', label: 'Users & licences (write)', access: 'write', appKey: 'graph_user_write',
    description: 'Create and disable users, reset passwords, assign Microsoft 365 licences.',
    scopes: ['User.ReadWrite.All', 'Directory.ReadWrite.All'],
  },
  {
    key: 'group_write', label: 'Groups & Teams (write)', access: 'write', appKey: 'graph_group_write',
    description: 'Create and manage security/distribution groups and Teams membership.',
    scopes: ['Group.ReadWrite.All'],
  },
  {
    key: 'mail_write', label: 'Mailbox actions (write)', access: 'write', appKey: 'graph_mail_write',
    description: "Manage mailbox rules and send on a customer's behalf (e.g. onboarding automations).",
    scopes: ['Mail.ReadWrite', 'Mail.Send'],
  },
];

export function getCapability(key: string): Capability | undefined {
  return CAPABILITIES.find((c) => c.key === key);
}

// The app (client id/secret) that backs a capability. 'reporting' → the shared read-only
// reporting app; every write pack → its own settings-group creds (client_id/secret), so
// each capability is a distinct Entra app that consents to only its own scopes.
export async function capabilityApp(cap: Capability): Promise<{ clientId: string; clientSecret: string }> {
  if (cap.appKey === 'reporting') return reportingApp();
  const id = ((await getSetting(cap.appKey, 'client_id').catch(() => '')) || '').trim();
  const secret = ((await getSetting(cap.appKey, 'secret').catch(() => '')) || '').trim();
  return { clientId: id, clientSecret: secret };
}

// Per-tenant admin-consent URL for one capability's app (v2, explicit redirect to the Portal).
export function capabilityConsentUrl(clientId: string, tenantId: string): string {
  const redirect = ((config.APP_URL || 'https://portal.lumenmsp.co.uk').replace(/\/+$/, '')) + '/auth/callback';
  return `https://login.microsoftonline.com/${encodeURIComponent(tenantId)}/v2.0/adminconsent`
    + `?client_id=${encodeURIComponent(clientId)}`
    + `&scope=${encodeURIComponent('https://graph.microsoft.com/.default')}`
    + `&redirect_uri=${encodeURIComponent(redirect)}`;
}
