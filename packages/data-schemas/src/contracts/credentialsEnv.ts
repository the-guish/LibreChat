/**
 * Test credentials for the stores that encrypt with `~/crypto` (user keys), which reads
 * `CREDS_KEY` and `CREDS_IV` once, when it is first loaded. A backend's spec for such a contract
 * imports this module first, as a side-effect import, so the values are set before the stores
 * load; values already set (a CI environment) are kept. Nothing here may import `mongoose` or the
 * MongoDB driver.
 */
process.env.CREDS_KEY = process.env.CREDS_KEY || 'a'.repeat(64);
process.env.CREDS_IV = process.env.CREDS_IV || 'b'.repeat(32);
