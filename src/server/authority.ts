import type { Node } from "prosemirror-model";
import { Step } from "prosemirror-transform";
import { schema } from "../shared/markdown.ts";

export type ClientID = string | number;
// Steps `version`..`version + steps.length`, each with the Collaborator that made it.
export type StepsMessage = { type: "steps"; version: number; steps: unknown[]; clientIDs: ClientID[] };

// Holds one Post's official document, Version and in-memory Step log (ADR 0001).
export function createAuthority(doc: Node) {
  const log: { step: Step; clientID: ClientID }[] = [];

  return {
    get doc() {
      return doc;
    },
    // The Version is the number of accepted Steps.
    get version() {
      return log.length;
    },
    // What a client at `version` is missing. Throws on a Version this Authority never had.
    stepsSince(version: number): StepsMessage {
      if (!Number.isInteger(version) || version < 0 || version > log.length) throw new Error(`no Version ${version}`);
      const missing = log.slice(version);
      return { type: "steps", version, steps: missing.map(({ step }) => step.toJSON()), clientIDs: missing.map(({ clientID }) => clientID) };
    },
    // Accepts Steps only when based on the current Version: false means stale, the client must rebase.
    // Throws, accepting none, when a Step does not apply.
    receive(version: number, steps: unknown[], clientID: ClientID): boolean {
      if (version !== log.length) return false;
      let next = doc;
      const accepted = steps.map((json) => {
        const step = Step.fromJSON(schema, json);
        const result = step.apply(next);
        if (!result.doc) throw new Error(`Step does not apply: ${result.failed}`);
        next = result.doc;
        return { step, clientID };
      });
      next.check();
      // Clients refuse a transaction that removes the Front Matter Block, so one must never become official.
      if (doc.firstChild?.type === schema.nodes.front_matter && next.firstChild?.type !== schema.nodes.front_matter) throw new Error("Steps remove the Front Matter Block");
      doc = next;
      log.push(...accepted);
      return true;
    },
  };
}

export type Authority = ReturnType<typeof createAuthority>;
