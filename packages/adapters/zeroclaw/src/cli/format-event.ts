export function printZeroClawStreamEvent(raw: string, debug: boolean): void {
  const line = raw.trim();
  if (!line) return;

  if (!debug) {
    console.log(line);
    return;
  }

  if (line.startsWith("[zeroclaw:error]")) {
    console.error(line);
    return;
  }

  if (line.startsWith("[zeroclaw]")) {
    console.log(line);
    return;
  }

  console.log(line);
}
