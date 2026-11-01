import { createHash, randomBytes } from "node:crypto";
import { audit } from "../db/audit.ts";
import type { Db } from "../db/pool.ts";

/** Read sent mail to learn from it, and create drafts. Sending is not in scope. */
export const GMAIL_SCOPES = [
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/gmail.compose",
];

const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";

export type Fetch = typeof fetch;

export interface OAuthClient {
  clientId: string;
  clientSecret: string;
}

export interface AuthRequest {
  url: string;
  verifier: string;
  state: string;
}

const base64url = (buf: Buffer) => buf.toString("base64url");

/** A consent URL for Google's installed-app flow, with PKCE and a loopback redirect. */
export function buildAuthRequest(client: OAuthClient, redirectUri: string, scopes = GMAIL_SCOPES): AuthRequest {
  const verifier = base64url(randomBytes(32));
  const state = base64url(randomBytes(16));
  const params = new URLSearchParams({
    client_id: client.clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: scopes.join(" "),
    access_type: "offline",
    // Always ask, so Google returns a refresh token even on a second connect.
    prompt: "consent",
    code_challenge: base64url(createHash("sha256").update(verifier).digest()),
    code_challenge_method: "S256",
    state,
  });
  return { url: `${AUTH_URL}?${params}`, verifier, state };
}

interface TokenResponse {
  access_token: string;
  expires_in: number;
  refresh_token?: string;
  scope?: string;
}

async function postToken(params: Record<string, string>, fetchFn: Fetch): Promise<TokenResponse> {
  const res = await fetchFn(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params),
  });
  const body = (await res.json().catch(() => ({}))) as TokenResponse & { error?: string; error_description?: string };
  if (!res.ok) {
    throw new Error(`Google sign-in failed: ${body.error_description ?? body.error ?? `HTTP ${res.status}`}`);
  }
  return body;
}

export async function exchangeCode(
  client: OAuthClient,
  code: string,
  verifier: string,
  redirectUri: string,
  fetchFn: Fetch = fetch,
): Promise<TokenResponse> {
  return postToken(
    {
      code,
      client_id: client.clientId,
      client_secret: client.clientSecret,
      redirect_uri: redirectUri,
      grant_type: "authorization_code",
      code_verifier: verifier,
    },
    fetchFn,
  );
}

export interface GoogleAccount {
  email: string;
  refreshToken: string;
  scopes: string;
}

export async function saveAccount(db: Db, account: GoogleAccount): Promise<void> {
  await db.query(
    `insert into google_accounts (email, refresh_token, scopes) values ($1, $2, $3)
     on conflict (email) do update set refresh_token = excluded.refresh_token, scopes = excluded.scopes, updated_at = now()`,
    [account.email, account.refreshToken, account.scopes],
  );
  // The token itself never goes into the audit log.
  await audit(db, "owner", "google.connected", { email: account.email, scopes: account.scopes });
}

export async function loadAccount(db: Db, email?: string): Promise<GoogleAccount | null> {
  const { rows } = await db.query<{ email: string; refresh_token: string; scopes: string }>(
    email
      ? "select email, refresh_token, scopes from google_accounts where email = $1"
      : "select email, refresh_token, scopes from google_accounts order by updated_at desc limit 1",
    email ? [email] : [],
  );
  const row = rows[0];
  return row ? { email: row.email, refreshToken: row.refresh_token, scopes: row.scopes } : null;
}

/** Hands out access tokens for one account, refreshing a minute before they expire. */
export class AccessTokenSource {
  private cached: { token: string; expiresAt: number } | null = null;

  constructor(
    private readonly client: OAuthClient,
    private readonly refreshToken: string,
    private readonly fetchFn: Fetch = fetch,
    private readonly now: () => number = Date.now,
  ) {}

  async get(): Promise<string> {
    if (this.cached && this.cached.expiresAt - 60_000 > this.now()) return this.cached.token;
    const res = await postToken(
      {
        client_id: this.client.clientId,
        client_secret: this.client.clientSecret,
        refresh_token: this.refreshToken,
        grant_type: "refresh_token",
      },
      this.fetchFn,
    );
    this.cached = { token: res.access_token, expiresAt: this.now() + res.expires_in * 1000 };
    return res.access_token;
  }
}
