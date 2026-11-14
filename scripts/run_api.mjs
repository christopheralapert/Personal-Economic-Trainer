import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = fileURLToPath(new URL("../", import.meta.url));
const python = path.join(root, process.platform === "win32" ? ".venv/Scripts/python.exe" : ".venv/bin/python");
const child = spawn(python, ["-m", "uvicorn", "app.main:app", "--app-dir", "backend/api", "--host", "127.0.0.1", "--port", process.env.MONEYLENS_API_PORT ?? "8000", "--no-access-log", ...process.argv.slice(2)], {cwd:root,stdio:"inherit",windowsHide:true});
child.on("error", () => {console.error("Create .venv and install backend/api/requirements.txt before starting the API.");process.exitCode=1;});
child.on("exit", code => {process.exitCode=code ?? 0;});
for (const signal of ["SIGINT","SIGTERM"]) process.on(signal, () => child.kill(signal));
