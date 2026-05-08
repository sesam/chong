export class SSEStream {
  private writer: WritableStreamDefaultWriter<Uint8Array>;
  private encoder = new TextEncoder();
  readonly response: Response;
  private closed = false;

  constructor() {
    const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
    this.writer = writable.getWriter();
    this.response = new Response(readable, {
      headers: {
        "content-type": "text/event-stream",
        "cache-control": "no-cache, no-transform",
        connection: "keep-alive",
        "x-accel-buffering": "no",
      },
    });
  }

  async send(event: string, data: string): Promise<void> {
    if (this.closed) return;
    const lines = [
      `event: ${event}`,
      ...data.split("\n").map((l) => `data: ${l}`),
      "",
      "",
    ];
    await this.writer.write(this.encoder.encode(lines.join("\n")));
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    try {
      await this.writer.close();
    } catch {
      // already closed by transport
    }
  }
}
