import http from "node:http";

export interface CapturedProviderRequest {
  method: string;
  url: string;
  headers: http.IncomingHttpHeaders;
  body: unknown;
  rawBody: string;
}

export interface ScriptedProviderResponse {
  status?: number;
  body: unknown;
  headers?: Record<string, string>;
}

export class RuntimeV2LoopbackProvider {
  readonly requests: CapturedProviderRequest[] = [];
  readonly #responses: ScriptedProviderResponse[];
  readonly #waiters: Array<{ index: number; resolve(): void }> = [];
  readonly #server: http.Server;
  #baseUrl = "";

  private constructor(responses: ScriptedProviderResponse[]) {
    this.#responses = [...responses];
    this.#server = http.createServer((request, response) => void this.#handle(request, response));
  }

  static async start(responses: ScriptedProviderResponse[]): Promise<RuntimeV2LoopbackProvider> {
    const provider = new RuntimeV2LoopbackProvider(responses);
    await new Promise<void>((resolve, reject) => {
      provider.#server.once("error", reject);
      provider.#server.listen(0, "127.0.0.1", () => {
        provider.#server.off("error", reject);
        resolve();
      });
    });
    const address = provider.#server.address();
    if (!address || typeof address === "string") throw new Error("loopback Provider address is unavailable");
    provider.#baseUrl = `http://127.0.0.1:${address.port}/v1`;
    return provider;
  }

  get baseUrl(): string { return this.#baseUrl; }
  get remainingResponses(): number { return this.#responses.length; }

  async waitForRequest(index: number, timeoutMs = 2_000): Promise<CapturedProviderRequest> {
    if (this.requests[index]) return this.requests[index];
    await new Promise<void>((resolve, reject) => {
      const waiter = { index, resolve: () => { clearTimeout(timer); resolve(); } };
      const timer = setTimeout(() => {
        const position = this.#waiters.indexOf(waiter);
        if (position >= 0) this.#waiters.splice(position, 1);
        reject(new Error(`Provider request ${index} was not received`));
      }, timeoutMs);
      this.#waiters.push(waiter);
    });
    const captured = this.requests[index];
    if (!captured) throw new Error(`Provider request ${index} is unavailable`);
    return captured;
  }

  async close(): Promise<void> {
    await new Promise<void>((resolve, reject) => this.#server.close((error) => error ? reject(error) : resolve()));
  }

  async #handle(request: http.IncomingMessage, response: http.ServerResponse): Promise<void> {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    const rawBody = Buffer.concat(chunks).toString("utf8");
    let body: unknown;
    try { body = JSON.parse(rawBody); } catch { body = null; }
    this.requests.push({ method: request.method ?? "", url: request.url ?? "", headers: request.headers, body, rawBody });
    for (let index = this.#waiters.length - 1; index >= 0; index -= 1) {
      const waiter = this.#waiters[index];
      if (!this.requests[waiter.index]) continue;
      this.#waiters.splice(index, 1);
      waiter.resolve();
    }
    const scripted = this.#responses.shift();
    if (!scripted) {
      response.writeHead(500, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "UNSCRIPTED_PROVIDER_REQUEST" }));
      return;
    }
    response.writeHead(scripted.status ?? 200, { "content-type": "application/json", ...scripted.headers });
    response.end(JSON.stringify(scripted.body));
  }
}

export function toolCallProviderResponse(toolCallId: string, name: string, args: unknown) {
  return {
    id: "response-tool-call", model: "deepseek-chat",
    choices: [{ finish_reason: "tool_calls", message: { role: "assistant", content: null,
      tool_calls: [{ id: toolCallId, type: "function", function: { name, arguments: JSON.stringify(args) } }] } }],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  };
}

export function completionProviderResponse(text: string) {
  return {
    id: "response-complete", model: "deepseek-chat",
    choices: [{ finish_reason: "stop", message: { role: "assistant", content: text } }],
    usage: { prompt_tokens: 20, completion_tokens: 8, total_tokens: 28 },
  };
}
