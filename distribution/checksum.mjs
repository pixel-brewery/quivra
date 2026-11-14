import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { writeFile } from "node:fs/promises";
import { basename } from "node:path";

const path = process.argv[2];
const hash = createHash("sha256");
for await (const chunk of createReadStream(path)) {
    hash.update(chunk);
}
await writeFile(path + ".sha256", hash.digest("hex") + "  " + basename(path) + "\n");
