import fs from "node:fs";
import path from "node:path";

const dataDir = path.resolve(process.cwd(), "data");

for (const file of [
    "minidex.sqlite",
    "minidex.sqlite-shm",
    "minidex.sqlite-wal",
]) {
    const filePath = path.join(dataDir, file);

    if (fs.existsSync(filePath)) {
        fs.rmSync(filePath, { force: true });
    }
}