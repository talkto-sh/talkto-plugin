/**
 * The part of OpenCode 2's plugin API this plugin uses (`@opencode/plugin`
 * 2.2.5, `dist/promise/*.d.ts`). Declared here so the plugin needs no
 * OpenCode package to type-check. OpenCode brands its IDs (session, method);
 * at run time they are plain strings, which is all this plugin handles.
 */
import type { Json, JsonObject } from "./core/mcp.ts";

export interface Registration {
  readonly dispose: () => Promise<void>;
}
export type Transform<Editor> = (callback: (editor: Editor) => void) => Promise<Registration>;

/** `Credential.OAuth`: what OpenCode stores for an OAuth connection and renews through `refresh`. */
export interface OAuthCredential {
  readonly type: "oauth";
  readonly methodID: string;
  readonly refresh: string;
  readonly access: string;
  /** Epoch milliseconds. */
  readonly expires: number;
  readonly metadata?: JsonObject;
}
/** `Credential.Value`: only the OAuth kind is this plugin's. */
export interface StoredCredential {
  readonly type: string;
  readonly access?: string;
}
export interface Authorization {
  readonly url: string;
  readonly instructions: string;
  readonly mode: "auto";
  readonly callback: Promise<OAuthCredential>;
}
export interface OAuthMethodRegistration {
  readonly integrationID: string;
  readonly method: { readonly id: string; readonly type: "oauth"; readonly label: string };
  readonly authorize: () => Promise<Authorization>;
  readonly refresh: (credential: OAuthCredential) => Promise<OAuthCredential>;
}
export interface IntegrationEditor {
  readonly update: (id: string, update: (integration: { name: string }) => void) => void;
  readonly method: { readonly update: (input: OAuthMethodRegistration) => void };
}
/** An active connection, passed back to OpenCode unread. */
export interface Connection {
  readonly integrationID?: string;
  readonly type?: string;
}

/** A tool as `ToolEditor.add` takes it. */
export interface Tool {
  readonly name: string;
  readonly description: string;
  readonly input: JsonObject;
  readonly options: { readonly codemode: boolean };
  readonly execute: (
    input: JsonObject,
    context: { readonly sessionID: string },
  ) => Promise<{ readonly content: string }>;
}
export interface ToolEditor {
  readonly add: (tool: Tool) => void;
}

/** The fields of an OpenCode event this plugin reads. */
export interface Event {
  readonly type: string;
  readonly data?: { readonly sessionID?: string; readonly inboxID?: string };
}

export interface Context {
  readonly integration: {
    readonly transform: Transform<IntegrationEditor>;
    readonly connection: {
      readonly active: (integrationID: string) => Promise<Connection | undefined>;
      readonly resolve: (connection: Connection) => Promise<StoredCredential | undefined>;
    };
  };
  readonly tool: {
    readonly transform: Transform<ToolEditor>;
    readonly reload: () => Promise<void>;
  };
  readonly session: {
    /** Returns the inbox row; its id is what `session.inbox.delivered` reports. */
    readonly prompt: (input: {
      readonly sessionID: string;
      readonly text: string;
      readonly delivery: "queue" | "steer";
    }) => Promise<{ readonly id: string }>;
  };
  readonly event: {
    readonly subscribe: (options: { readonly signal: AbortSignal }) => AsyncIterable<Event>;
  };
  readonly storage: {
    readonly get: (key: string) => Promise<Json | undefined>;
    readonly set: (key: string, value: Json) => Promise<void>;
    readonly remove: (key: string) => Promise<void>;
    readonly scan: (options: { readonly prefix: string }) => Promise<{
      readonly entries: ReadonlyArray<{ readonly key: string; readonly value: Json }>;
    }>;
  };
}
export type Cleanup = () => void;
export interface Plugin {
  readonly id: string;
  readonly setup: (context: Context) => Promise<Cleanup | void>;
}
