export interface LogSink {
  write(line: string): void;
}

/**
 * All logging passes through here (R33). Any value registered via
 * `registerSecret` is replaced with `[redacted]` before a line is written.
 * Conversation bodies are never logged by callers in the first place; this layer
 * is only a backstop against incidental sensitive substrings (e.g. local paths).
 */
export class RedactingLogger {
  private readonly secrets = new Set<string>();
  private readonly sink: LogSink;

  constructor(sink?: LogSink) {
    this.sink = sink ?? { write: (line) => process.stderr.write(`${line}\n`) };
  }

  /** Register sensitive values to scrub. Short values are ignored to avoid
   *  over-redacting common substrings. */
  registerSecret(...values: (string | null | undefined)[]): void {
    for (const value of values) {
      if (value && value.length >= 6) this.secrets.add(value);
    }
  }

  redact(text: string): string {
    let out = text;
    for (const secret of this.secrets) out = out.replaceAll(secret, '[redacted]');
    return out;
  }

  log(message: string): void {
    this.sink.write(this.redact(message));
  }
}
