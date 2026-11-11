/**
 * The loopback half of browser sign-in: a one-shot listener on 127.0.0.1 that
 * receives the authorization server's redirect. Node and Bun both provide
 * node:http, so every host without its own OAuth client uses this.
 */
import { createServer } from "node:http";
import { isText } from "./talkto.ts";

/** The browser's answer. */
export interface Answer {
  readonly code: string;
  readonly state: string;
}

/** Reads the code and state from the redirect address, or the error it carries. */
export const answerOf = (address: URL): Answer => {
  const error = address.searchParams.get("error");
  if (error !== null)
    throw new Error(
      `TalkTo sign-in was refused: ${address.searchParams.get("error_description") ?? error}`,
    );
  const code = address.searchParams.get("code");
  const state = address.searchParams.get("state");
  if (code === null || state === null) throw new Error("The sign-in answer has no code.");
  return { code, state };
};

const page = (text: string) =>
  `<!doctype html><meta charset="utf-8"><title>TalkTo</title><p style="font:16px system-ui;margin:3rem">${text}</p>`;

/** A one-shot callback listener on 127.0.0.1; any port, chosen by the system. */
export const listen = async (host: string) => {
  let settle: { resolve: (answer: Answer) => void; reject: (cause: Error) => void } | null = null;
  const answer = new Promise<Answer>((resolve, reject) => {
    settle = { resolve, reject };
  });
  // Handled here so a sign-in finished another way never leaves an unhandled rejection.
  answer.catch(() => undefined);
  const server = createServer((request, response) => {
    const address = new URL(request.url ?? "/", "http://127.0.0.1");
    if (address.pathname !== "/callback") {
      response.writeHead(404).end();
      return;
    }
    try {
      const received = answerOf(address);
      response.writeHead(200, { "content-type": "text/html" });
      response.end(page(`Signed in to TalkTo. You can close this tab and return to ${host}.`));
      settle?.resolve(received);
    } catch (cause) {
      response.writeHead(400, { "content-type": "text/html" });
      response.end(page(`TalkTo sign-in did not finish. Return to ${host} and try again.`));
      settle?.reject(cause instanceof Error ? cause : new Error(String(cause)));
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const bound = server.address();
  const port = bound !== null && !isText(bound) ? bound.port : 0;
  return {
    redirectUri: `http://127.0.0.1:${port}/callback`,
    answer,
    close: () => {
      settle?.reject(new Error("Sign-in closed."));
      server.close();
    },
  };
};
