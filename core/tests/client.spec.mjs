// The MCP client and browser sign-in used by hosts without an MCP client of
// their own (pi, and opencode's fallback), against a fake TalkTo.
import assert from "node:assert/strict";
import { test } from "node:test";
import { SignInRequired, callTool, protocolVersion } from "../src/mcp.ts";
import { discover, exchange, isStale, refresh, register, start } from "../src/oauth.ts";

const response = (status, body, contentType = "application/json") => ({
  status,
  headers: { get: (name) => (name.toLowerCase() === "content-type" ? contentType : null) },
  text: async () => (String(body) === body ? body : JSON.stringify(body)),
});
/** A fetch that answers from a table of URL → handler and records every request. */
const fakeFetch = (routes) => {
  const requests = [];
  const fetch = async (url, init) => {
    requests.push({ url, ...init });
    const handler = routes[url];
    if (handler === undefined) return response(404, { error: "not_found" });
    return handler(init);
  };
  return { fetch, requests };
};
const endpoint = (fetch, token = "token-1") => ({
  url: "https://talkto.test/mcp",
  token: async () => token,
  clientName: "talkto-plugin test",
  clientVersion: "0.1.0",
  fetch,
});
const result = {
  isError: false,
  content: [{ type: "text", text: "{}" }],
  structuredContent: { data: 1 },
};

test("a tool call is one stateless 2026-07-28 request carrying the host's current token", async () => {
  const { fetch, requests } = fakeFetch({
    "https://talkto.test/mcp": () => response(200, { jsonrpc: "2.0", id: 1, result }),
  });
  const answer = await callTool(endpoint(fetch), "get_updates", { mode: "poll", waitSeconds: 20 });
  assert.deepEqual(answer, result);
  const [sent] = requests;
  assert.equal(sent.headers.authorization, "Bearer token-1");
  assert.equal(sent.headers["MCP-Protocol-Version"], protocolVersion);
  assert.equal(sent.headers["Mcp-Name"], "get_updates");
  const body = JSON.parse(sent.body);
  assert.equal(body.method, "tools/call");
  assert.deepEqual(body.params.arguments, { mode: "poll", waitSeconds: 20 });
  assert.equal(body.params._meta["io.modelcontextprotocol/protocolVersion"], protocolVersion);
});

test("an event-stream answer, a tool error and a protocol error are each read correctly", async () => {
  const stream = `event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: 1, result })}\n\n`;
  const sse = fakeFetch({
    "https://talkto.test/mcp": () => response(200, stream, "text/event-stream"),
  });
  assert.deepEqual(await callTool(endpoint(sse.fetch), "get_context", {}), result);

  const toolError = { isError: true, content: [], structuredContent: { error: { code: "x" } } };
  const failing = fakeFetch({
    "https://talkto.test/mcp": () => response(200, { jsonrpc: "2.0", id: 1, result: toolError }),
  });
  assert.equal((await callTool(endpoint(failing.fetch), "get_context", {})).isError, true);

  const protocol = fakeFetch({
    "https://talkto.test/mcp": () =>
      response(200, { jsonrpc: "2.0", id: 1, error: { code: -32602, message: "bad arguments" } }),
  });
  await assert.rejects(callTool(endpoint(protocol.fetch), "get_context", {}), /bad arguments/);
});

test("no credential or a refused one asks the person to sign in", async () => {
  const { fetch, requests } = fakeFetch({
    "https://talkto.test/mcp": () => response(401, { error: "invalid_token" }),
  });
  await assert.rejects(callTool(endpoint(fetch, null), "get_context", {}), SignInRequired);
  assert.equal(requests.length, 0, "nothing is sent without a credential");
  await assert.rejects(callTool(endpoint(fetch), "get_context", {}), SignInRequired);
});

test("sign-in discovers the server, registers a public client, and uses PKCE with the MCP resource", async () => {
  const issuer = "https://auth.talkto.test";
  const { fetch, requests } = fakeFetch({
    "https://talkto.test/.well-known/oauth-protected-resource/mcp": () =>
      response(200, { resource: "https://talkto.test/mcp", authorization_servers: [issuer] }),
    [`${issuer}/.well-known/oauth-authorization-server`]: () =>
      response(200, {
        issuer,
        authorization_endpoint: `${issuer}/authorize`,
        token_endpoint: `${issuer}/token`,
        registration_endpoint: `${issuer}/register`,
      }),
    [`${issuer}/register`]: () => response(201, { client_id: "client-1" }),
    [`${issuer}/token`]: (init) => {
      const form = new URLSearchParams(init.body);
      return form.get("grant_type") === "authorization_code"
        ? response(200, { access_token: "a1", refresh_token: "r1", expires_in: 300 })
        : response(200, { access_token: "a2", expires_in: 300 });
    },
  });
  const server = await discover("https://talkto.test/mcp", fetch);
  assert.equal(server.tokenEndpoint, `${issuer}/token`);
  const redirect = "http://127.0.0.1:43210/callback";
  const clientId = await register(server, redirect, "talkto-plugin for pi", fetch);
  assert.equal(clientId, "client-1");
  const registration = JSON.parse(requests.at(-1).body);
  assert.equal(registration.token_endpoint_auth_method, "none");
  assert.deepEqual(registration.redirect_uris, [redirect]);

  const pending = await start(server, clientId, redirect);
  const url = new URL(pending.url);
  assert.equal(url.searchParams.get("code_challenge_method"), "S256");
  assert.equal(url.searchParams.get("resource"), "https://talkto.test/mcp");
  assert.match(url.searchParams.get("scope"), /offline_access/);
  assert.notEqual(url.searchParams.get("code_challenge"), pending.verifier);

  await assert.rejects(exchange(server, pending, "code", "forged", 0, fetch), /does not match/);
  const credential = await exchange(server, pending, "code", pending.state, 1000, fetch);
  assert.deepEqual(credential, { accessToken: "a1", refreshToken: "r1", expiresAt: 301000 });
  const sent = new URLSearchParams(requests.at(-1).body);
  assert.equal(sent.get("code_verifier"), pending.verifier);

  assert.equal(isStale(credential, 1000), false);
  assert.equal(isStale(credential, 300000), true, "renewed a minute before expiry");
  const renewed = await refresh(server, clientId, credential, 2000, fetch);
  assert.deepEqual(renewed, { accessToken: "a2", refreshToken: "r1", expiresAt: 302000 });
});
