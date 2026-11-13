// Antigravity transcripts in agy 1.5.7's format, for tests: one step per line. A model step lists
// its tool calls, and their results follow in order, each some header lines and then the tool's
// JSON. Every link here is fake.

export const server = "7c1e9a52-3b0f-4c55-9d7e-0d2f3c4b5a61";
export const signalA = "0b7a3c1d-2e4f-4a6b-8c9d-1e2f3a4b5c6d";
export const signalB = "5e6f7a8b-9c0d-4e1f-8a2b-3c4d5e6f7a8b";
export const expiresAt = "2030-01-01T00:00:00.000Z";
/** @param {string} signal @param {string} [origin] */
export const fakeLink = (signal, origin = "https://talkto.example") =>
  `${origin}/v1/signals/${server}/${signal}.${"Q".repeat(43)}`;

let step = 0;
/** @param {Record<string, unknown>} fields */
export const line = (fields) => JSON.stringify({ step_index: step++, status: "DONE", ...fields });
/**
 * A model step's tool calls. `quoted` mirrors transcript.jsonl, which JSON-encodes each argument;
 * transcript_full.jsonl does not.
 * @param {ReadonlyArray<string>} names @param {boolean} [quoted]
 */
export const calls = (names, quoted = true) =>
  line({
    source: "MODEL",
    type: "PLANNER_RESPONSE",
    tool_calls: names.map((name) =>
      name === "run_command"
        ? { name, args: { CommandLine: quoted ? '"echo hi"' : "echo hi" } }
        : {
            name: "call_mcp_tool",
            args: {
              Arguments: "{}",
              ServerName: quoted ? '"talkto"' : "talkto",
              ToolName: quoted ? JSON.stringify(name) : name,
            },
          },
    ),
  });
export const header =
  "Created At: 2026-11-12T17:20:29-05:00\nCompleted At: 2026-11-12T17:20:32-05:00\n";
/** @param {unknown} body @param {Record<string, unknown>} [extra] */
export const result = (body, extra = {}) =>
  line({ source: "MODEL", type: "GENERIC", content: header + JSON.stringify(body), ...extra });
/** create_signal's result. @param {string} signal @param {string} [url] */
export const signalResult = (signal, url = fakeLink(signal)) =>
  result({
    data: { signalId: signal, url, expiresAt, selection: { channelIds: [], directChats: "own" } },
    included: { participants: [], conversations: [] },
    meta: { requestId: "00000000-0000-4000-8000-000000000001" },
  });
/** create_signal's result as transcript.jsonl records a long one: cut short. @param {string} signal */
export const cutResult = (signal) =>
  line({
    source: "MODEL",
    type: "GENERIC",
    content: `${header}{"data":{"signalId":"${signal}","u`,
    truncated_fields: ["content"],
  });
export const user = () => line({ source: "USER_EXPLICIT", type: "USER_INPUT", content: "go" });
export const note = () =>
  line({ source: "SYSTEM_SDK", type: "EPHEMERAL_MESSAGE", content: "TalkTo: note" });
/** @param {ReadonlyArray<string>} lines */
export const transcript = (...lines) => `${lines.join("\n")}\n`;
