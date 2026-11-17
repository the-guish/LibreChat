/**
 * The search configuration of the search sync contract (`searchSync.contract.ts`): search on,
 * a MeiliSearch host and key (the runner replaces the `meilisearch` package with `./meiliFake`,
 * so nothing is contacted), and small sync batches without delays, so every paging path runs.
 * The backends read these when their search code loads (the MongoDB plugin's `SEARCH` flag) or
 * when their models and stores are built, so a runner imports this module first, as a
 * side-effect import. Nothing here may import `mongoose` or the MongoDB driver.
 */
process.env.SEARCH = 'true';
process.env.MEILI_HOST = 'http://meili.contract.test';
process.env.MEILI_MASTER_KEY = 'contract-master-key';
process.env.MEILI_SYNC_BATCH_SIZE = '2';
process.env.MEILI_SYNC_DELAY_MS = '0';
process.env.MEILI_NO_SYNC = 'false';
