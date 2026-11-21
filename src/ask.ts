import Anthropic from "@anthropic-ai/sdk";
import { search } from "./search.ts";
import type { Vault } from "./vault.ts";

export const ASK_MODEL = "claude-opus-5-5";
const MAX_SOURCES = 8;

const SYSTEM = `You answer questions from the user's personal notes. Each note excerpt is provided as a document.
Answer only from these documents and cite them. If they do not contain the answer, say so plainly instead of guessing.
Keep the answer short and direct.`;

export interface Source {
  /** Citation number used in the answer text, starting at 1. */
  n: number;
  path: string;
  title: string;
  heading: string;
  line: number;
  /** Passages the model quoted from this note section. */
  quotes: string[];
}

export interface Answer {
  /** Answer text with [n] markers that refer to sources. */
  answer: string;
  sources: Source[];
  model: string;
}

/** An error whose message is safe and useful to show to the user. */
export class AskError extends Error {}

/** "Ask" is opt-in: it only exists when the user has put a Claude credential in the environment. */
export function askAvailable(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env.ANTHROPIC_API_KEY || env.ANTHROPIC_AUTH_TOKEN);
}

export type CreateMessage = (params: Anthropic.Beta.MessageCreateParamsNonStreaming) => Promise<Anthropic.Beta.BetaMessage>;

function describe(error: unknown): AskError {
  if (error instanceof Anthropic.AuthenticationError) return new AskError("Anthropic rejected the API key. Check ANTHROPIC_API_KEY.");
  if (error instanceof Anthropic.PermissionDeniedError) return new AskError("This API key is not allowed to use the model.");
  if (error instanceof Anthropic.NotFoundError) return new AskError("The model is not available to this API key. Set VAULTMIND_ASK_MODEL to one that is.");
  if (error instanceof Anthropic.RateLimitError) return new AskError("Anthropic rate limit reached. Try again in a minute.");
  if (error instanceof Anthropic.APIConnectionError) return new AskError("Could not reach the Anthropic API. Check your network connection.");
  if (error instanceof Anthropic.APIError) return new AskError(`Anthropic API error ${error.status ?? ""}: ${error.message}`);
  return new AskError(error instanceof Error ? error.message : String(error));
}

/**
 * Answers a question from the vault: retrieves the best matching sections locally, then asks Claude to answer
 * from them with citations. Only those sections and the question leave the machine.
 */
export async function ask(vault: Vault, question: string, create?: CreateMessage): Promise<Answer> {
  if (!create && !askAvailable()) throw new AskError("Ask needs an Anthropic API key. Set ANTHROPIC_API_KEY and restart.");
  const model = process.env.VAULTMIND_ASK_MODEL || ASK_MODEL;
  const { hits } = await search(vault.db, question, { limit: MAX_SOURCES, embedder: vault.embedder });
  if (hits.length === 0) return { answer: "Nothing in the vault matches this question.", sources: [], model };

  create ??= ((client) => (params) => client.beta.messages.create(params))(new Anthropic());
  const request: Anthropic.Beta.MessageCreateParamsNonStreaming = {
    model,
    max_tokens: 16000,
    output_config: { effort: "medium" },
    system: SYSTEM,
    messages: [
      {
        role: "user",
        content: [
          ...hits.map(
            (hit): Anthropic.Beta.BetaRequestDocumentBlock => ({
              type: "document",
              source: { type: "text", media_type: "text/plain", data: hit.text },
              title: hit.heading ? `${hit.title} (${hit.heading})` : hit.title,
              context: `Note file: ${hit.path}`,
              citations: { enabled: true },
            }),
          ),
          { type: "text", text: question },
        ],
      },
    ],
  };

  let message: Anthropic.Beta.BetaMessage;
  try {
    try {
      // If a safety classifier declines, let the API re-run the request on its default fallback model.
      message = await create({ ...request, betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" });
    } catch (error) {
      // A 400 here usually means this account cannot use the fallback beta: the plain request still works.
      if (!(error instanceof Anthropic.BadRequestError)) throw error;
      message = await create(request);
    }
  } catch (error) {
    throw describe(error);
  }
  if (message.stop_reason === "refusal") throw new AskError("The model declined to answer this question.");

  const sources = new Map<number, Source>();
  let answer = "";
  for (const block of message.content) {
    if (block.type !== "text") continue;
    answer += block.text;
    const cited = new Set<number>();
    for (const citation of block.citations ?? []) {
      if (!("document_index" in citation)) continue;
      const hit = hits[citation.document_index];
      if (!hit) continue;
      let source = sources.get(citation.document_index);
      if (!source) {
        source = { n: sources.size + 1, path: hit.path, title: hit.title, heading: hit.heading, line: hit.line, quotes: [] };
        sources.set(citation.document_index, source);
      }
      if (!source.quotes.includes(citation.cited_text)) source.quotes.push(citation.cited_text);
      cited.add(source.n);
    }
    for (const n of cited) answer += ` [${n}]`;
  }
  if (message.stop_reason === "max_tokens") answer += " …(answer cut off)";
  return { answer: answer.trim(), sources: [...sources.values()], model: message.model };
}
