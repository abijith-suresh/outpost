// Disposable synthetic Git driver, never connects to a service.
import { appendFileSync, readSync, writeSync } from "node:fs";

const [mode, marker] = process.argv.slice(2);
const convert = (data, direction) => {
  appendFileSync(marker, `${direction}\n`);
  return direction === "smudge" ? `WORK:${data}` : data.replace(/^WORK:/, "");
};
if (mode !== "process") {
  let data = "";
  for await (const chunk of process.stdin) data += chunk;
  process.stdout.write(convert(data, mode));
} else {
  const read = (n) => {
    const result = Buffer.alloc(n);
    let count = 0;
    while (count < n) {
      const got = readSync(0, result, count, n - count, null);
      if (!got) return null;
      count += got;
    }
    return result;
  };
  const packet = () => {
    const header = read(4);
    if (!header) return null;
    const size = Number.parseInt(header.toString(), 16);
    return size ? read(size - 4) : Buffer.alloc(0);
  };
  const group = () => {
    const values = [];
    let value = packet();
    while (value?.length) {
      values.push(value);
      value = packet();
    }
    return value === null ? null : values;
  };
  const send = (text) => {
    const data = Buffer.from(text);
    writeSync(1, (data.length + 4).toString(16).padStart(4, "0"));
    writeSync(1, data);
  };
  const flush = () => writeSync(1, "0000");
  group();
  send("git-filter-server\n");
  send("version=2\n");
  flush();
  group();
  send("capability=clean\n");
  send("capability=smudge\n");
  flush();
  let headers = group();
  while (headers !== null) {
    const direction = headers
      .find((h) => h.toString().startsWith("command="))
      ?.toString()
      .trim()
      .slice(8);
    const content = Buffer.concat(group() ?? []).toString();
    send("status=success\n");
    flush();
    const output = Buffer.from(convert(content, direction));
    for (let index = 0; index < output.length; index += 60000)
      send(output.subarray(index, index + 60000));
    flush();
    flush();
    headers = group();
  }
}
