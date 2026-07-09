import { getSetting } from './settings';

// Open Banking transaction sync. Provider-agnostic adapter — recommended provider: GoCardless
// Bank Account Data (free, UK/EU AISP) or TrueLayer. Going live needs:
//   1. A provider account + API keys (stored in Admin → Integrations under group 'openbanking').
//   2. A one-time bank-consent (OAuth) flow to authorise the account (AISP consent, ~90-day renew).
//   3. The account/requisition id to pull transactions from.
// Until those exist this throws a clear message; use the CSV import in the meantime.

export async function syncOpenBanking(): Promise<number> {
  const key = await getSetting('openbanking', 'secret_id');
  const account = await getSetting('openbanking', 'account_id');
  if (!key || !account) {
    throw new Error('Open Banking is not connected yet. Add the provider keys + authorise the bank account in Admin → Integrations (or use CSV import for now).');
  }
  // TODO (next phase): exchange creds → token, GET /accounts/{account}/transactions, then upsert
  // each into bank_transactions (source='openbanking', external_id=provider txn id) like the CSV path.
  throw new Error('Open Banking keys found but the sync flow is not wired yet — coming in the next phase.');
}
