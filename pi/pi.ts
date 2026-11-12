/**
 * The part of pi's extension API this extension uses (pi 0.85,
 * `@earendil-works/pi-coding-agent` `dist/core/extensions/types.d.ts`).
 * Declared here so the extension needs no pi package to type-check; pi's
 * own objects satisfy these shapes at run time.
 */
import type { Json, JsonObject } from "./core/mcp.ts";

export interface TextContent {
  readonly type: "text";
  readonly text: string;
}
/** What a tool returns to the model. */
export interface ToolResult {
  readonly content: TextContent[];
  readonly details: null;
}
/** Arguments pi has already checked against the tool's JSON Schema. */
export type ToolParams = { readonly [key: string]: Json };
/** A JSON Schema object. */
export type Schema = JsonObject;

export interface Ui {
  readonly setStatus: (key: string, text: string | undefined) => void;
  readonly notify: (message: string, type?: "info" | "warning" | "error") => void;
}
/** What pi resolves for a provider's stored credential, refreshed when close to expiry. */
export interface ProviderAuth {
  readonly auth: { readonly apiKey?: string };
}
/** `ctx`: valid until the session shuts down. */
export interface Context {
  readonly mode: "tui" | "rpc" | "json" | "print";
  readonly hasUI: boolean;
  readonly ui: Ui;
  readonly isIdle: () => boolean;
  readonly hasPendingMessages: () => boolean;
  readonly sessionManager: { readonly getSessionId: () => string };
  readonly modelRegistry: {
    readonly getProviderAuth: (provider: string) => Promise<ProviderAuth | undefined>;
  };
}

export interface ToolDefinition {
  readonly name: string;
  readonly label: string;
  readonly description: string;
  readonly promptSnippet?: string;
  readonly parameters: Schema;
  readonly execute: (
    toolCallId: string,
    params: ToolParams,
    signal: AbortSignal | undefined,
    onUpdate: undefined,
    ctx: Context,
  ) => Promise<ToolResult>;
}

/** Any pi event; lifecycle handlers read only its type. */
export interface Event {
  readonly type: string;
}
/** A message as `message_start` reports it; custom message kinds may lack content. */
export interface Message {
  readonly role?: string;
  readonly content?: unknown;
}
export interface MessageStart {
  readonly type: "message_start";
  readonly message: Message;
}

/** pi's legacy extension OAuth surface (`OAuthLoginCallbacks`). */
export interface LoginCallbacks {
  readonly onAuth: (info: { readonly url: string; readonly instructions?: string }) => void;
  readonly onProgress?: (message: string) => void;
  readonly onManualCodeInput?: () => Promise<string>;
  readonly signal?: AbortSignal;
}
/**
 * What pi stores in auth.json for the provider. The extra fields are saved at
 * sign-in so renewal needs no discovery; they are checked before use because
 * the file is outside this extension's control.
 */
export type StoredCredential = {
  readonly access: string;
  readonly refresh: string;
  /** Epoch milliseconds. */
  readonly expires: number;
  readonly clientId?: unknown;
  readonly tokenEndpoint?: unknown;
  readonly resource?: unknown;
};
export interface OAuthProvider {
  readonly name: string;
  readonly login: (callbacks: LoginCallbacks) => Promise<StoredCredential>;
  readonly refreshToken: (
    credentials: StoredCredential,
    signal: AbortSignal,
  ) => Promise<StoredCredential>;
  readonly getApiKey: (credentials: StoredCredential) => string;
}

/** An event handler; pi passes the event and a current `ctx`. */
export type Handler<E> = (event: E, ctx: Context) => Promise<void> | void;

export interface Pi {
  readonly on: {
    (event: "session_start", handler: Handler<Event>): void;
    (event: "session_shutdown", handler: Handler<Event>): void;
    /** Awaited before the turn takes its tool list; a tool registered here is in that turn. */
    (event: "before_agent_start", handler: Handler<Event>): void;
    (event: "agent_start", handler: Handler<Event>): void;
    (event: "agent_settled", handler: Handler<Event>): void;
    (event: "message_start", handler: Handler<MessageStart>): void;
  };
  readonly registerTool: (tool: ToolDefinition) => void;
  readonly registerCommand: (
    name: string,
    options: {
      readonly description: string;
      readonly handler: (args: string, ctx: Context) => Promise<void>;
    },
  ) => void;
  readonly sendUserMessage: (
    content: string,
    options: { readonly deliverAs: "steer" | "followUp" },
  ) => void;
  readonly registerProvider: (
    name: string,
    config: { readonly name: string; readonly baseUrl: string; readonly oauth: OAuthProvider },
  ) => void;
}
