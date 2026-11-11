/**
 * The TalkTo side of the plugin: the `get_updates` reply decoded into what a
 * notice needs. A hooks module imports only its own files, so this decodes the
 * server's JSON by hand; anything that does not match is a failure, never a
 * guess.
 */

/** One incoming message, as much as a notice shows. */
export interface IncomingMessage {
  readonly id: string;
  readonly conversationId: string;
  readonly senderId: string;
  readonly createdAt: string;
  readonly body: string;
  readonly isUrgent: boolean;
  /** "#general" or "direct chat with planner". */
  readonly where: string;
  /** "planner (codex)", or the sender ID when the reply did not describe it. */
  readonly from: string;
}

/** One `get_updates` page. */
export interface UpdatesPage {
  readonly messages: ReadonlyArray<IncomingMessage>;
  readonly checkpoint: string;
  readonly hasMore: boolean;
}

/** A failed call: TalkTo's error code and message, or `transport` when the call itself failed. */
export interface UpdatesFailure {
  readonly code: string;
  readonly message: string;
}

/** What an MCP tools/call answered, as the host hands it over. */
export interface ToolAnswer {
  readonly isError: boolean;
  readonly structuredContent?: unknown;
  readonly content: ReadonlyArray<{ readonly type: string; readonly text?: string }>;
}

export type UpdatesReply =
  | { readonly kind: "page"; readonly page: UpdatesPage }
  | { readonly kind: "failure"; readonly failure: UpdatesFailure };

/** An object's own fields; reading through a map needs no assertion about its shape. */
export type Fields = ReadonlyMap<string, unknown>;
export const isObject = (value: unknown): value is object =>
  value !== null && Object(value) === value;
export const isText = (value: unknown): value is string => String(value) === value;
/** The object under `key`, as fields, or null when it is absent or not an object. */
export const fieldsAt = (fields: Fields, key: string): Fields | null => {
  const found = fields.get(key);
  return isObject(found) ? new Map(Object.entries(found)) : null;
};
export const textOf = (fields: Fields, key: string): string | null => {
  const found = fields.get(key);
  return isText(found) ? found : null;
};
export const listOf = (fields: Fields, key: string): ReadonlyArray<unknown> => {
  const found = fields.get(key);
  return Array.isArray(found) ? found : [];
};

/** The reply envelope: structured content when the server declared it, else the first text block. */
const envelopeOf = (answer: ToolAnswer): Fields | null => {
  if (isObject(answer.structuredContent)) return new Map(Object.entries(answer.structuredContent));
  const text = answer.content.find((block) => block.type === "text")?.text;
  if (text === undefined) return null;
  try {
    const parsed: unknown = JSON.parse(text);
    return isObject(parsed) ? new Map(Object.entries(parsed)) : null;
  } catch {
    return null;
  }
};

const failure = (code: string, message: string): UpdatesReply => ({
  kind: "failure",
  failure: { code, message },
});

/** Decode one `get_updates` answer for `participantId`, naming senders and conversations from `included`. */
export const decodeUpdates = (answer: ToolAnswer, participantId: string): UpdatesReply => {
  const envelope = envelopeOf(answer);
  if (envelope === null) return failure("unreadable", "TalkTo answered with no readable result.");
  const error = fieldsAt(envelope, "error");
  if (error !== null)
    return failure(
      textOf(error, "code") ?? "unknown",
      textOf(error, "message") ?? "TalkTo reported an error.",
    );
  const data = fieldsAt(envelope, "data");
  const checkpoint = data === null ? null : textOf(data, "checkpoint");
  if (data === null || checkpoint === null)
    return failure("unreadable", "TalkTo answered without a checkpoint.");
  const included = fieldsAt(envelope, "included");
  const names = new Map<string, string>();
  for (const entry of included === null ? [] : listOf(included, "participants")) {
    if (!isObject(entry)) continue;
    const item: Fields = new Map(Object.entries(entry));
    const id = textOf(item, "id"),
      name = textOf(item, "name"),
      type = textOf(item, "agentType");
    if (id !== null && name !== null) names.set(id, type === null ? name : `${name} (${type})`);
  }
  const places = new Map<string, string>();
  for (const entry of included === null ? [] : listOf(included, "conversations")) {
    if (!isObject(entry)) continue;
    const item: Fields = new Map(Object.entries(entry));
    const id = textOf(item, "id");
    if (id === null) continue;
    const name = textOf(item, "name");
    if (name !== null) {
      places.set(id, `#${name}`);
      continue;
    }
    const other = listOf(item, "participantIds").find(
      (member): member is string => isText(member) && member !== participantId,
    );
    const otherName = other === undefined ? undefined : names.get(other)?.replace(/ \(.*\)$/, "");
    places.set(id, otherName === undefined ? "a direct chat" : `direct chat with ${otherName}`);
  }
  const messages: IncomingMessage[] = [];
  for (const entry of listOf(data, "messages")) {
    if (!isObject(entry))
      return failure("unreadable", "TalkTo answered with an unreadable message.");
    const item: Fields = new Map(Object.entries(entry));
    const id = textOf(item, "id"),
      conversationId = textOf(item, "conversationId"),
      senderId = textOf(item, "senderId"),
      createdAt = textOf(item, "createdAt"),
      body = textOf(item, "body");
    if (
      id === null ||
      conversationId === null ||
      senderId === null ||
      createdAt === null ||
      body === null
    )
      return failure("unreadable", "TalkTo answered with an incomplete message.");
    messages.push({
      id,
      conversationId,
      senderId,
      createdAt,
      body,
      isUrgent: textOf(item, "priority") === "urgent",
      where: places.get(conversationId) ?? `conversation ${conversationId}`,
      from: names.get(senderId) ?? `participant ${senderId}`,
    });
  }
  return {
    kind: "page",
    page: { messages, checkpoint, hasMore: textOf(data, "nextCursor") !== null },
  };
};
