/**
 * A minimal MCP client for hosts that have no MCP connection of their own.
 * TalkTo speaks stateless MCP 2026-07-28, so a tool call is one POST with no
 * session to set up. The caller supplies a fresh access token per call; this
 * file never stores one.
 */
import { isObject, listOf, type Fields, type ToolAnswer } from "./talkto.ts";

/** The MCP protocol revision this client speaks. */
export const protocolVersion = "2026-07-28";

/** A JSON value as a tool argument. */
export type Json =
  | string
  | number
  | boolean
  | null
  | ReadonlyArray<Json>
  | { readonly [key: string]: Json };

/** TalkTo refused the credential, or there is none: the person must sign in again. */
export class SignInRequired extends Error {
  override readonly name = "SignInRequired";
}

/** The part of an HTTP response this client reads; the global fetch's Response fits. */
export interface HttpResponse {
  readonly status: number;
  readonly headers: { readonly get: (name: string) => string | null };
  readonly text: () => Promise<string>;
}
/** The request this client sends. */
export interface HttpRequest {
  readonly method: "POST";
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
}
/** The global fetch, or a test double. */
export type Fetch = (url: string, init: HttpRequest) => Promise<HttpResponse>;

/** Where and as whom to call. */
export interface Endpoint {
  /** TalkTo's MCP URL, e.g. https://talkto.sh/mcp. */
  readonly url: string;
  /** A current access token, or null when the person has not signed in. */
  readonly token: () => Promise<string | null>;
  readonly clientName: string;
  readonly clientVersion: string;
  readonly fetch: Fetch;
}

/** A JSON object, as tools/list describes an input schema. */
export type JsonObject = { readonly [key: string]: Json };

/** True for a value JSON can carry; used on parsed payloads before they reach a host. */
export const isJson = (value: unknown): value is Json => {
  if (value === null || value === true || value === false) return true;
  if (String(value) === value) return true;
  if (Number(value) === value) return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJson);
  return isObject(value) && Object.values(value).every(isJson);
};
const isJsonObject = (value: unknown): value is JsonObject =>
  isObject(value) && !Array.isArray(value) && isJson(value);

const readAnswer = (fields: Fields): ToolAnswer => {
  const content = listOf(fields, "content").flatMap((block) => {
    if (!isObject(block)) return [];
    const entry: Fields = new Map(Object.entries(block));
    const type = entry.get("type");
    const text = entry.get("text");
    if (String(type) !== type) return [];
    return String(text) === text ? [{ type, text }] : [{ type }];
  });
  const structured = fields.get("structuredContent");
  const isError = fields.get("isError") === true;
  return structured === undefined
    ? { isError, content }
    : { isError, content, structuredContent: structured };
};

/** The fields of a parsed JSON object, or null for anything else. */
const objectIn = (text: string): Fields | null => {
  const parsed: unknown = JSON.parse(text);
  return isObject(parsed) ? new Map(Object.entries(parsed)) : null;
};

/** The JSON-RPC message in a response body, whether sent as JSON or as a finite event stream. */
const messageOf = (text: string, contentType: string | null): Fields | null => {
  if (contentType?.includes("text/event-stream") !== true) return objectIn(text);
  for (const line of text.split("\n")) {
    if (!line.startsWith("data: ")) continue;
    const message = objectIn(line.slice(6));
    if (message !== null && (message.has("result") || message.has("error"))) return message;
  }
  return null;
};

let requests = 0;

/** One JSON-RPC request; resolves to its result. Rejects with SignInRequired when there is no usable credential. */
const request = async (
  endpoint: Endpoint,
  method: "tools/call" | "tools/list",
  name: string | null,
  params: { readonly [key: string]: Json },
): Promise<Fields> => {
  const token = await endpoint.token();
  if (token === null) throw new SignInRequired("Sign in to TalkTo first.");
  const routing: Readonly<Record<string, string>> = name === null ? {} : { "Mcp-Name": name };
  const response = await endpoint.fetch(endpoint.url, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "MCP-Protocol-Version": protocolVersion,
      "Mcp-Method": method,
      ...routing,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: (requests += 1),
      method,
      params: {
        ...params,
        _meta: {
          "io.modelcontextprotocol/protocolVersion": protocolVersion,
          "io.modelcontextprotocol/clientCapabilities": {},
          "io.modelcontextprotocol/clientInfo": {
            name: endpoint.clientName,
            version: endpoint.clientVersion,
          },
        },
      },
    }),
  });
  if (response.status === 401) throw new SignInRequired("TalkTo did not accept the sign-in.");
  const text = await response.text();
  let message: Fields | null;
  try {
    message = messageOf(text, response.headers.get("content-type"));
  } catch {
    throw new Error(`TalkTo answered HTTP ${response.status} with an unreadable body.`);
  }
  if (message === null)
    throw new Error(`TalkTo answered HTTP ${response.status} without a result.`);
  const error = message.get("error");
  if (isObject(error)) {
    const detail = new Map(Object.entries(error)).get("message");
    throw new Error(`TalkTo refused the call: ${String(detail ?? "unknown error")}`);
  }
  const result = message.get("result");
  if (!isObject(result)) throw new Error(`TalkTo answered ${method} without a result.`);
  return new Map(Object.entries(result));
};

/** Calls one TalkTo tool. */
export const callTool = async (
  endpoint: Endpoint,
  name: string,
  args: Json,
): Promise<ToolAnswer> => {
  return readAnswer(await request(endpoint, "tools/call", name, { name, arguments: args }));
};

/** One tool TalkTo offers, as tools/list describes it. */
export interface ToolInfo {
  readonly name: string;
  readonly title: string | null;
  readonly description: string;
  /** JSON Schema of the arguments, passed through to the host unchanged. */
  readonly inputSchema: JsonObject;
}

/** The tools TalkTo offers this connection. */
export const listTools = async (endpoint: Endpoint): Promise<ReadonlyArray<ToolInfo>> => {
  const result = await request(endpoint, "tools/list", null, {});
  return listOf(result, "tools").flatMap((entry) => {
    if (!isObject(entry)) return [];
    const fields: Fields = new Map(Object.entries(entry));
    const name = fields.get("name");
    const description = fields.get("description");
    const title = fields.get("title");
    const schema = fields.get("inputSchema");
    if (String(name) !== name || !isJsonObject(schema)) return [];
    return [
      {
        name,
        title: String(title) === title ? title : null,
        description: String(description) === description ? description : "",
        inputSchema: schema,
      },
    ];
  });
};
