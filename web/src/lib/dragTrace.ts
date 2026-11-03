// The drag debug log's input from the drag and resize code: state machine
// starts, transitions and why each ended. A no-op unless the "Drag log"
// window (?debug=drag) has connected a sink. Nothing is sent or stored.

let sink: ((line: string) => void) | null = null;

export function setTraceSink(fn: ((line: string) => void) | null): void {
  sink = fn;
}

export function trace(line: string): void {
  sink?.(line);
}
