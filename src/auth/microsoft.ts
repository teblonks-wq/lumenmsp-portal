import * as msal from '@azure/msal-node';
import { config } from '../config';

// Lazy-initialize — don't crash on startup if Azure creds not yet configured
let _msalClient: msal.ConfidentialClientApplication | null = null;

function getMsalClient(): msal.ConfidentialClientApplication {
  if (!_msalClient) {
    if (!config.AZURE_CLIENT_ID || !config.AZURE_CLIENT_SECRET) {
      throw new Error('Microsoft SSO is not configured. Set AZURE_CLIENT_ID and AZURE_CLIENT_SECRET in .env');
    }
    // Authority selection:
    //  • AZURE_MULTI_TENANT='true' → /organizations: any WORK/SCHOOL tenant may authenticate,
    //    but the /auth/callback then enforces a tenant allow-list (home tenant + customers'
    //    recorded entra_tenant_id), so only approved customer tenants actually get in.
    //  • else single-tenant when AZURE_TENANT_ID is set (staff only); /common as a last resort.
    const authority = config.AZURE_MULTI_TENANT === 'true'
      ? 'https://login.microsoftonline.com/organizations'
      : config.AZURE_TENANT_ID
        ? `https://login.microsoftonline.com/${config.AZURE_TENANT_ID}`
        : 'https://login.microsoftonline.com/common';
    _msalClient = new msal.ConfidentialClientApplication({
      auth: {
        clientId:     config.AZURE_CLIENT_ID,
        authority,
        clientSecret: config.AZURE_CLIENT_SECRET,
      },
    });
  }
  return _msalClient;
}

export function getAuthCodeUrl(state: string): Promise<string> {
  return getMsalClient().getAuthCodeUrl({
    scopes:      ['openid', 'profile', 'email', 'User.Read'],
    redirectUri: config.AZURE_REDIRECT_URI,
    state,
  });
}

export async function acquireTokenByCode(code: string): Promise<msal.AuthenticationResult> {
  return getMsalClient().acquireTokenByCode({
    code,
    scopes:      ['openid', 'profile', 'email', 'User.Read'],
    redirectUri: config.AZURE_REDIRECT_URI,
  });
}
