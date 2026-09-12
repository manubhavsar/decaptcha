/**
 * Side-effect import that loads .env before anything else runs.
 *
 * This exists because ES module imports are hoisted: a plain `loadEnv()` call
 * at the top of server.js would execute *after* every import in that file had
 * already been evaluated. Importing this module first is the ordering
 * guarantee. Same convention as `dotenv/config`.
 */
import { loadEnv } from './env.js';

loadEnv();
