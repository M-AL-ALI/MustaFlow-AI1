import { IncompleteAgentModelResponseError } from "./agent-model-request";

type Block = {
  type: string;
  id?: string;
  name?: string;
  initialJson?: string;
  initialEmpty?: boolean;
  fragments: string[];
  hasDelta: boolean;
  closed: boolean;
};

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The SDK's final input is a permissively parsed snapshot, not the wire JSON.
 * Keep a private copy of raw tool input and validate only after message_stop.
 */
export class AnthropicStreamToolInput {
  private readonly blocks = new Map<number, Block>();
  private readonly ids = new Set<string>();
  private started = false;
  private stopped = false;
  private invalid = false;

  observe(event: unknown): void {
    if (!record(event) || typeof event.type !== "string") {
      this.invalid = true;
      return;
    }
    if (event.type === "message_start") {
      if (
        this.started ||
        this.stopped ||
        !record(event.message) ||
        !Array.isArray(event.message.content) ||
        event.message.content.length !== 0
      ) {
        this.invalid = true;
      }
      this.started = true;
      return;
    }
    if (event.type === "message_stop") {
      if (!this.started || this.stopped) this.invalid = true;
      this.stopped = true;
      return;
    }
    if (!event.type.startsWith("content_block_")) return;
    if (
      !this.started ||
      this.stopped ||
      typeof event.index !== "number" ||
      !Number.isInteger(event.index) ||
      event.index < 0
    ) {
      this.invalid = true;
      return;
    }

    if (event.type === "content_block_start") {
      const content = event.content_block;
      if (
        this.blocks.has(event.index) ||
        event.index !== this.blocks.size ||
        !record(content) ||
        typeof content.type !== "string"
      ) {
        this.invalid = true;
        return;
      }
      const block: Block = {
        type: content.type,
        fragments: [],
        hasDelta: false,
        closed: false,
      };
      if (content.type === "tool_use") {
        if (
          typeof content.id !== "string" ||
          content.id.length === 0 ||
          typeof content.name !== "string" ||
          content.name.length === 0 ||
          this.ids.has(content.id) ||
          !record(content.input)
        ) {
          this.invalid = true;
          return;
        }
        block.id = content.id;
        block.name = content.name;
        this.ids.add(content.id);
        // Copy now: the SDK may replace or mutate its snapshot later.
        block.initialJson = JSON.stringify(content.input);
        block.initialEmpty = Object.keys(content.input).length === 0;
      }
      this.blocks.set(event.index, block);
      return;
    }

    const block = this.blocks.get(event.index);
    if (!block || block.closed) {
      this.invalid = true;
      return;
    }
    if (event.type === "content_block_stop") {
      block.closed = true;
      return;
    }
    if (event.type === "content_block_delta") {
      if (!record(event.delta)) {
        this.invalid = true;
        return;
      }
      if (event.delta.type === "input_json_delta") {
        if (
          block.type !== "tool_use" ||
          !block.initialEmpty ||
          typeof event.delta.partial_json !== "string"
        ) {
          this.invalid = true;
          return;
        }
        block.hasDelta = true;
        block.fragments.push(event.delta.partial_json);
      }
    }
  }

  finish(content: unknown): Map<number, string> {
    const incomplete = () =>
      new IncompleteAgentModelResponseError("Streamed tool instructions were incomplete.");
    if (
      this.invalid ||
      !this.started ||
      !this.stopped ||
      !Array.isArray(content) ||
      content.length !== this.blocks.size
    ) {
      throw incomplete();
    }
    const argumentsByIndex = new Map<number, string>();
    for (const [index, observed] of this.blocks) {
      const final: unknown = content[index];
      if (!observed.closed || !record(final) || final.type !== observed.type) {
        throw incomplete();
      }
      if (observed.type !== "tool_use") continue;
      if (final.id !== observed.id || final.name !== observed.name) throw incomplete();
      const raw = observed.hasDelta ? observed.fragments.join("") : observed.initialJson;
      if (raw === undefined) throw incomplete();
      try {
        if (!record(JSON.parse(raw))) throw incomplete();
      } catch {
        throw incomplete();
      }
      argumentsByIndex.set(index, raw);
    }
    return argumentsByIndex;
  }
}
