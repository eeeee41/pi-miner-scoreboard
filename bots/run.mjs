// Runs the investor bots once (see bots/core.js). Started by .github/workflows/bots.yml.
// Needs FIREBASE_SERVICE_ACCOUNT: the JSON of a Firebase service-account key, stored as a
// GitHub Actions secret. Admin access skips the security rules, so keep that key secret.
import { createRequire } from "node:module";
import admin from "firebase-admin";
import { FieldValue } from "firebase-admin/firestore";

const require = createRequire(import.meta.url);
const { runBots } = require("./core.js");

const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
if (!raw) {
  console.error("FIREBASE_SERVICE_ACCOUNT isn't set. Add the service-account key as a repository secret " +
    "(Settings → Secrets and variables → Actions → New repository secret).");
  process.exit(1);
}
let key;
try { key = JSON.parse(raw); } catch {
  console.error("FIREBASE_SERVICE_ACCOUNT isn't valid JSON. Paste the whole downloaded key file as the secret's value.");
  process.exit(1);
}
admin.initializeApp({ credential: admin.credential.cert(key) });
const db = admin.firestore();

const started = Date.now();
const summary = await runBots({ db, FieldValue, log: (line) => console.log(line) });
console.log(`Done: ${summary.length} bots in ${((Date.now() - started) / 1000).toFixed(1)} s`);
