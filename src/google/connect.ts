import { execFile } from "node:child_process";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { loadConfig } from "../config.ts";
import { migrate } from "../db/migrate.ts";
import { createPool } from "../db/pool.ts";
import { GmailClient } from "./gmail.ts";
import { buildAuthRequest, exchangeCode, GMAIL_SCOPES, saveAccount } from "./oauth.ts";

// One-time Google sign-in: `npm run google:connect`. Opens the browser, catches Google's redirect
// on a local port, and stores the refresh token in the database. The token is never printed.

const config = loadConfig();
if (!config.GOOGLE_CLIENT_ID || !config.GOOGLE_CLIENT_SECRET) {
  console.error("Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in .env first (see README, Gmail).");
  process.exit(1);
}
const client = { clientId: config.GOOGLE_CLIENT_ID, clientSecret: config.GOOGLE_CLIENT_SECRET };
const db = createPool(config.DATABASE_URL);
await migrate(db);

const server = createServer();
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const redirectUri = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
const auth = buildAuthRequest(client, redirectUri);

const code = await new Promise<string>((resolve, reject) => {
  server.on("request", (req, res) => {
    const url = new URL(req.url ?? "/", redirectUri);
    const error = url.searchParams.get("error");
    const got = url.searchParams.get("code");
    if (!error && !got) {
      res.writeHead(404).end();
      return;
    }
    const ok = !error && url.searchParams.get("state") === auth.state;
    res.writeHead(ok ? 200 : 400, { "content-type": "text/html; charset=utf-8" });
    res.end(ok ? "<p>Gmail is connected. You can close this tab.</p>" : `<p>Sign-in didn't finish: ${error ?? "state mismatch"}</p>`);
    if (ok && got) resolve(got);
    else reject(new Error(error ?? "The sign-in response didn't match this request."));
  });
  console.log("Opening Google sign-in in your browser. If it doesn't open, paste this link into it:\n");
  console.log(auth.url, "\n");
  if (process.platform === "darwin") execFile("open", [auth.url], () => undefined);
});

try {
  const tokens = await exchangeCode(client, code, auth.verifier, redirectUri);
  if (!tokens.refresh_token) throw new Error("Google didn't return a refresh token. Run this again.");
  const email = await new GmailClient(async () => tokens.access_token).profileEmail();
  await saveAccount(db, { email, refreshToken: tokens.refresh_token, scopes: tokens.scope ?? GMAIL_SCOPES.join(" ") });
  console.log(`Connected ${email}. Restart the bot, then send it /collect_emails.`);
} finally {
  server.close();
  await db.end();
}
