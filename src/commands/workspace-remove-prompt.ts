import process from "node:process";
import { createInterface } from "node:readline/promises";

import type { AgentsOwnership } from "../workspace-agents.js";

export type AgentsRemovalPromptRequest = {
  readonly ticket: string;
  readonly agentsFilePath: string;
  readonly ownership: Extract<AgentsOwnership, "modified" | "foreign">;
};

export type AgentsRemovalPrompt = (
  request: AgentsRemovalPromptRequest,
) => Promise<boolean>;

export type PromptReadline = {
  question(question: string): Promise<string>;
  once(event: "SIGINT" | "close", listener: () => void): unknown;
  close(): void;
};

type AgentsRemovalPromptOptions = {
  readonly createReadline?: () => PromptReadline;
};

function promptMessage(request: AgentsRemovalPromptRequest): string {
  return request.ownership === "modified"
    ? `Workspace AGENTS.md has been modified. Delete it and continue removing workspace ${request.ticket}? [y/N] `
    : `Workspace AGENTS.md is not managed by outpost. Delete it and continue removing workspace ${request.ticket}? [y/N] `;
}

export function makeAgentsRemovalPrompt(
  options: AgentsRemovalPromptOptions = {},
): AgentsRemovalPrompt {
  const createReadline =
    options.createReadline ??
    (() =>
      createInterface({
        input: process.stdin,
        output: process.stderr,
      }));

  return (request) => {
    const readline = createReadline();

    return new Promise<boolean>((resolve) => {
      let settled = false;
      let closed = false;

      const closeOnce = () => {
        if (closed) {
          return;
        }

        closed = true;
        try {
          readline.close();
        } catch {
          // A closing readline can reject question() and race this cleanup.
        }
      };

      const settle = (consent: boolean, close: boolean) => {
        if (settled) {
          return;
        }

        settled = true;
        if (close) {
          closeOnce();
        }
        resolve(consent);
      };

      readline.once("close", () => {
        closed = true;
        settle(false, false);
      });
      readline.once("SIGINT", () => settle(false, true));

      Promise.resolve()
        .then(() => readline.question(promptMessage(request)))
        .then(
          (answer) => {
            const normalized = answer.trim().toLowerCase();
            settle(normalized === "y" || normalized === "yes", true);
          },
          () => settle(false, true),
        );
    });
  };
}

export const promptAgentsRemovalConsent = makeAgentsRemovalPrompt();
