/**
 * TalkTo sign-in as a pi OAuth provider: `/login talkto` runs `login`, pi
 * keeps the credential in its own auth store (auth.json, file-locked) and
 * calls `refreshToken` when it is close to expiry. The extension reads a
 * current token only through `ctx.modelRegistry.getProviderAuth("talkto")`.
 */
import { answerOf, listen } from "./core/loopback.ts";
import * as OAuth from "./core/oauth.ts";
import { isText } from "./core/talkto.ts";
import type { LoginCallbacks, OAuthProvider, StoredCredential } from "./pi.ts";

/** The provider name `/login` lists; also the key pi stores the credential under. */
export const providerName = "talkto";
const clientName = "talkto-plugin for pi";

/** What sign-in needs from the outside world; tests substitute all of it. */
export interface LoginDeps {
  readonly mcpUrl: string;
  readonly fetch: OAuth.FormFetch;
  readonly now: () => number;
}

const aborted = (signal: AbortSignal | undefined) =>
  new Promise<never>((_resolve, reject) => {
    if (signal === undefined) return;
    if (signal.aborted) reject(new Error("TalkTo sign-in was cancelled."));
    signal.addEventListener("abort", () => reject(new Error("TalkTo sign-in was cancelled.")));
  });

const stored = (
  credential: OAuth.Credential,
  clientId: string,
  server: OAuth.Server,
): StoredCredential => ({
  access: credential.accessToken,
  refresh: credential.refreshToken ?? "",
  expires: credential.expiresAt,
  clientId,
  tokenEndpoint: server.tokenEndpoint,
  resource: server.resource,
});

/** Browser sign-in: register a public client for this loopback address, then PKCE. */
export const login = async (deps: LoginDeps, callbacks: LoginCallbacks) => {
  const server = await OAuth.discover(deps.mcpUrl, deps.fetch);
  const loopback = await listen("pi");
  try {
    const clientId = await OAuth.register(server, loopback.redirectUri, clientName, deps.fetch);
    const pending = await OAuth.start(server, clientId, loopback.redirectUri);
    callbacks.onAuth({
      url: pending.url,
      instructions:
        "Sign in to TalkTo in your browser. If the browser runs on another machine, paste the address the browser ends on.",
    });
    callbacks.onProgress?.("Waiting for the TalkTo sign-in in your browser…");
    const pasted = callbacks.onManualCodeInput?.().then((text) => answerOf(new URL(text.trim())));
    pasted?.catch(() => undefined);
    const answer = await Promise.race([
      loopback.answer,
      ...(pasted === undefined ? [] : [pasted]),
      aborted(callbacks.signal),
    ]);
    const credential = await OAuth.exchange(
      server,
      pending,
      answer.code,
      answer.state,
      deps.now(),
      deps.fetch,
    );
    return stored(credential, clientId, server);
  } finally {
    loopback.close();
  }
};

/** Renews with the client and endpoint saved at sign-in; no discovery needed. */
export const renew = async (deps: LoginDeps, credentials: StoredCredential) => {
  const { clientId, tokenEndpoint, resource } = credentials;
  if (!isText(clientId) || !isText(tokenEndpoint) || !isText(resource))
    throw new Error("This TalkTo sign-in is from an older version; run /login talkto again.");
  const server: OAuth.Server = {
    resource,
    issuer: "",
    authorizationEndpoint: "",
    tokenEndpoint,
    registrationEndpoint: null,
  };
  const renewed = await OAuth.refresh(
    server,
    clientId,
    {
      accessToken: credentials.access,
      refreshToken: credentials.refresh === "" ? null : credentials.refresh,
      expiresAt: credentials.expires,
    },
    deps.now(),
    deps.fetch,
  );
  return stored(renewed, clientId, server);
};

/**
 * The provider registered with `pi.registerProvider`. `signedIn` gets the new
 * access token before pi stores it, so the running session can load TalkTo's
 * tools at once instead of after a restart. Its failure never fails sign-in.
 */
export const provider = (
  deps: LoginDeps,
  signedIn: (accessToken: string) => Promise<void> = async () => undefined,
) => ({
  name: "TalkTo",
  baseUrl: new URL(deps.mcpUrl).origin,
  oauth: {
    name: "TalkTo",
    login: async (callbacks) => {
      const credential = await login(deps, callbacks);
      await signedIn(credential.access).catch(() => undefined);
      return credential;
    },
    refreshToken: (credentials) => renew(deps, credentials),
    getApiKey: (credentials) => credentials.access,
  } satisfies OAuthProvider,
});
