/**
 * TalkTo sign-in as an OpenCode 2 integration: the person connects TalkTo in
 * OpenCode, which opens the browser, stores the credential in its own
 * credential store and calls `refresh` when it is close to expiry. The plugin
 * reads a current token only through `integration.connection.resolve`.
 */
import { listen } from "./core/loopback.ts";
import * as OAuth from "./core/oauth.ts";
import { isText } from "./core/talkto.ts";
import type { Authorization, OAuthCredential, OAuthMethodRegistration } from "./opencode.ts";

export const integrationID = "talkto";
export const methodID = "browser";
const clientName = "talkto-plugin for OpenCode";

/** What sign-in needs from the outside world; tests substitute all of it. */
export interface SignInDeps {
  readonly mcpUrl: string;
  readonly fetch: OAuth.FormFetch;
  readonly now: () => number;
}

const stored = (
  credential: OAuth.Credential,
  clientId: string,
  server: OAuth.Server,
): OAuthCredential => ({
  type: "oauth",
  methodID,
  access: credential.accessToken,
  refresh: credential.refreshToken ?? "",
  expires: credential.expiresAt,
  metadata: { clientId, tokenEndpoint: server.tokenEndpoint, resource: server.resource },
});

/** Starts a browser sign-in; OpenCode opens `url` and awaits `callback`. */
export const authorize = async (deps: SignInDeps): Promise<Authorization> => {
  const server = await OAuth.discover(deps.mcpUrl, deps.fetch);
  const loopback = await listen("OpenCode");
  try {
    const clientId = await OAuth.register(server, loopback.redirectUri, clientName, deps.fetch);
    const pending = await OAuth.start(server, clientId, loopback.redirectUri);
    const callback = loopback.answer
      .then((answer) =>
        OAuth.exchange(server, pending, answer.code, answer.state, deps.now(), deps.fetch),
      )
      .then((credential) => stored(credential, clientId, server))
      .finally(() => loopback.close());
    return {
      url: pending.url,
      instructions: "Sign in to TalkTo in your browser, then return to OpenCode.",
      mode: "auto",
      callback,
    };
  } catch (cause) {
    loopback.close();
    throw cause;
  }
};

/** Renews with the client and endpoint saved at sign-in. */
export const refresh = async (
  deps: SignInDeps,
  credential: OAuthCredential,
): Promise<OAuthCredential> => {
  const clientId = credential.metadata?.["clientId"];
  const tokenEndpoint = credential.metadata?.["tokenEndpoint"];
  const resource = credential.metadata?.["resource"];
  if (!isText(clientId) || !isText(tokenEndpoint) || !isText(resource))
    throw new Error("This TalkTo connection cannot be renewed; connect TalkTo again.");
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
      accessToken: credential.access,
      refreshToken: credential.refresh === "" ? null : credential.refresh,
      expiresAt: credential.expires,
    },
    deps.now(),
    deps.fetch,
  );
  return stored(renewed, clientId, server);
};

/** The OAuth method registered on the TalkTo integration. */
export const method = (deps: SignInDeps): OAuthMethodRegistration => ({
  integrationID,
  method: { id: methodID, type: "oauth", label: "Sign in with your browser" },
  authorize: () => authorize(deps),
  refresh: (credential) => refresh(deps, credential),
});
