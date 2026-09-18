// Runs in every test file's worker before the test module is imported, so the
// suites that never import lib/data/load themselves still find the committed
// data through the store. The data directory comes from STORE_DATA_DIR, set in
// vitest.config.mts.
import "./lib/data/load";
