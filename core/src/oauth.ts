/**
 * Browser sign-in to TalkTo's MCP server for hosts that have no MCP client of
 * their own: discovery from the MCP URL, client registration, PKCE, the code
 * exchange and refresh. The host stores the resulting credential and asks for
 * a refresh when it expires; nothing here writes a file.
 *
 * TalkTo's authorization server is WorkOS Connect, found through the MCP
 * URL's protected-resource metadata, so nothing here names a provider.
 */
import { isObject, type Fields } from "./talkto.ts";
import type { HttpResponse } from "./mcp.ts";

/** Scopes TalkTo's MCP clients ask for: identity, and a refresh token so the host can renew. */
export const scopes = "openid offline_access";

/** What sign-in needs to know about TalkTo's authorization server. */
export interface Server {
  /** The MCP URL tokens are issued for (RFC 8707 resource). */
  readonly resource: string;
  readonly issuer: string;
  readonly authorizationEndpoint: string;
  readonly tokenEndpoint: string;
  readonly registrationEndpoint: string | null;
}

/** A credential the host stores. `expiresAt` is epoch milliseconds. */
export interface Credential {
  readonly accessToken: string;
  readonly refreshToken: string | null;
  readonly expiresAt: number;
}

/** A sign-in in progress: open `url`, then exchange the code that comes back with `state`. */
export interface Pending {
  readonly url: string;
  readonly state: string;
  readonly verifier: string;
  readonly redirectUri: string;
  readonly clientId: string;
}

/** Form-encoded POSTs for the token endpoint; the global fetch fits. */
export type FormFetch = (
  url: string,
  init: {
    readonly method: "GET" | "POST";
    readonly headers: Readonly<Record<string, string>>;
    readonly body?: string;
  },
) => Promise<HttpResponse>;

const fieldsOf = async (response: HttpResponse, what: string): Promise<Fields> => {
  const text = await response.text();
  if (response.status < 200 || response.status >= 300)
    throw new Error(`${what} failed: HTTP ${response.status} ${text.slice(0, 200)}`);
  const parsed: unknown = JSON.parse(text);
  if (!isObject(parsed)) throw new Error(`${what} answered without an object.`);
  return new Map(Object.entries(parsed));
};
const required = (fields: Fields, key: string, what: string): string => {
  const value = fields.get(key);
  if (String(value) !== value || value === "") throw new Error(`${what} has no ${key}.`);
  return value;
};

/** Finds TalkTo's authorization server from the MCP URL. */
export const discover = async (mcpUrl: string, fetch: FormFetch): Promise<Server> => {
  const mcp = new URL(mcpUrl);
  const resourceDocument = await fieldsOf(
    await fetch(`${mcp.origin}/.well-known/oauth-protected-resource${mcp.pathname}`, {
      method: "GET",
      headers: { accept: "application/json" },
    }),
    "TalkTo resource metadata",
  );
  const servers = resourceDocument.get("authorization_servers");
  const issuer = Array.isArray(servers) ? servers.find((item) => String(item) === item) : null;
  if (issuer === undefined || issuer === null)
    throw new Error("TalkTo resource metadata names no authorization server.");
  const resource = required(resourceDocument, "resource", "TalkTo resource metadata");
  const base = String(issuer).replace(/\/$/, "");
  const metadata = await fieldsOf(
    await fetch(`${base}/.well-known/oauth-authorization-server`, {
      method: "GET",
      headers: { accept: "application/json" },
    }),
    "Authorization server metadata",
  );
  const registration = metadata.get("registration_endpoint");
  return {
    resource,
    issuer: base,
    authorizationEndpoint: required(metadata, "authorization_endpoint", "Server metadata"),
    tokenEndpoint: required(metadata, "token_endpoint", "Server metadata"),
    registrationEndpoint: String(registration) === registration ? registration : null,
  };
};

/** Registers this plugin as a public client for one loopback redirect URI (dynamic client registration). */
export const register = async (
  server: Server,
  redirectUri: string,
  clientName: string,
  fetch: FormFetch,
): Promise<string> => {
  if (server.registrationEndpoint === null)
    throw new Error("TalkTo's authorization server does not accept client registration.");
  const registered = await fieldsOf(
    await fetch(server.registrationEndpoint, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({
        client_name: clientName,
        redirect_uris: [redirectUri],
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
        scope: scopes,
      }),
    }),
    "Client registration",
  );
  return required(registered, "client_id", "Client registration");
};

const base64url = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
const randomText = (bytes: number) => base64url(crypto.getRandomValues(new Uint8Array(bytes)));

/** Starts a PKCE sign-in: the URL to open in the browser and what the exchange needs. */
export const start = async (
  server: Server,
  clientId: string,
  redirectUri: string,
): Promise<Pending> => {
  const verifier = randomText(32);
  const challenge = base64url(
    new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))),
  );
  const state = randomText(16);
  const url = new URL(server.authorizationEndpoint);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("scope", scopes);
  url.searchParams.set("state", state);
  url.searchParams.set("code_challenge", challenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("resource", server.resource);
  return { url: url.toString(), state, verifier, redirectUri, clientId };
};

const credentialOf = async (
  response: HttpResponse,
  now: number,
  previousRefresh: string | null,
): Promise<Credential> => {
  const fields = await fieldsOf(response, "Token request");
  const expires = fields.get("expires_in");
  const refresh = fields.get("refresh_token");
  return {
    accessToken: required(fields, "access_token", "Token response"),
    // A server that does not rotate refresh tokens omits it; keep the one we have.
    refreshToken: String(refresh) === refresh ? refresh : previousRefresh,
    expiresAt: now + (Number(expires) > 0 ? Number(expires) : 3600) * 1000,
  };
};

const form = (values: ReadonlyArray<readonly [string, string]>) => {
  const body = new URLSearchParams();
  for (const [key, value] of values) body.append(key, value);
  return body.toString();
};

/** Exchanges the code from the browser for a credential. Rejects a mismatched state. */
export const exchange = async (
  server: Server,
  pending: Pending,
  code: string,
  state: string,
  now: number,
  fetch: FormFetch,
): Promise<Credential> => {
  if (state !== pending.state) throw new Error("The sign-in answer does not match this sign-in.");
  return credentialOf(
    await fetch(server.tokenEndpoint, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: form([
        ["grant_type", "authorization_code"],
        ["code", code],
        ["redirect_uri", pending.redirectUri],
        ["client_id", pending.clientId],
        ["code_verifier", pending.verifier],
        ["resource", server.resource],
      ]),
    }),
    now,
    null,
  );
};

/** Renews a credential with its refresh token. */
export const refresh = async (
  server: Server,
  clientId: string,
  credential: Credential,
  now: number,
  fetch: FormFetch,
): Promise<Credential> => {
  if (credential.refreshToken === null)
    throw new Error("The TalkTo sign-in cannot be renewed; sign in again.");
  return credentialOf(
    await fetch(server.tokenEndpoint, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: form([
        ["grant_type", "refresh_token"],
        ["refresh_token", credential.refreshToken],
        ["client_id", clientId],
        ["resource", server.resource],
      ]),
    }),
    now,
    credential.refreshToken,
  );
};

/** Renew this long before expiry, so a call never carries a token that expires in flight. */
export const renewMarginMillis = 60 * 1000;
/** True when the credential should be renewed before use. */
export const isStale = (credential: Credential, now: number) =>
  credential.expiresAt - renewMarginMillis <= now;
