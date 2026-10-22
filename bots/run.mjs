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
try {
  admin.initializeApp({ credential: admin.credential.cert(key) });
} catch (e) {
  console.error(`That key didn't work: ${e.message}\nMake a new one in Firebase → Project settings → Service accounts → ` +
    "Generate new private key, and paste the whole file as the FIREBASE_SERVICE_ACCOUNT secret.");
  process.exit(1);
}
const db = admin.firestore();
console.log(`Running the investor bots for project ${key.project_id}`);

const started = Date.now();
try {
  const summary = await runBots({ db, FieldValue, log: (line) => console.log(line) });
  console.log(`Done: ${summary.length} bots in ${((Date.now() - started) / 1000).toFixed(1)} s`);
} catch (e) {
  const msg = String(e && e.message || e);
  console.error(`The bots stopped: ${msg}`);
  if (/PERMISSION_DENIED|permission/i.test(msg))
    console.error("Hint: the key's service account needs access to Firestore. Use the key from Firebase → Project settings → " +
      "Service accounts (the firebase-adminsdk account), for the piminerscoreboard project.");
  if (/UNAUTHENTICATED|invalid_grant|JWT/i.test(msg))
    console.error("Hint: the key was rejected. It may have been deleted or pasted incompletely: make a new one and update the secret.");
  if (/FAILED_PRECONDITION|index/i.test(msg))
    console.error("Hint: Firestore wants an index for one of the bots' queries. The message above has a link that creates it in one click.");
  process.exit(1);
}
