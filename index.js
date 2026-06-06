import syncFs from "node:fs";
import { cpus } from "node:os";
import fs from "node:fs/promises";
import { spawn } from "node:child_process";

const nodejsGithubRepo = "https://github.com/nodejs/node";
const DEFAULT_WINDOWS_X86_TAG = "v22.22.3";

let OS = process.env.OS;
const ARCH_MAP = {
  amd64: "x64",
  arm64: "arm64",
  x86: "x86",
};
const REQUESTED_ARCH = process.env.ARCH ?? "amd64";
const ARCH = ARCH_MAP[REQUESTED_ARCH];
if (!ARCH) {
  throw new Error(
    `Unsupported ARCH "${REQUESTED_ARCH}". Supported values: ${Object.keys(ARCH_MAP).join(", ")}`
  );
}

const coreCount = cpus().length;
const threadCount = coreCount * 2;
let current_os;
switch (process.platform) {
  case "darwin":
    current_os = "mac";
    break;
  case "win32":
    current_os = "win";
    break;
  default:
    current_os = "linux";
    break;
}
if (!OS) OS = current_os;

const spawnAsync = (program, args) =>
  new Promise((resolve, reject) => {
    console.log("Running:", [program, ...args].join(" "));

    const child = spawn(program, args, { shell: true });

    child.stdout.on("data", (chunk) => console.log(chunk.toString()));
    child.stderr.on("data", (chunk) => console.error(chunk.toString()));
    child.on("close", (code) => {
      if (code == 0) resolve(code.toString());
      else reject(code.toString());
    });
  });

const version =
  process.env.SOURCE_TAG ||
  (process.platform == "win32" && REQUESTED_ARCH == "x86"
    ? DEFAULT_WINDOWS_X86_TAG
    : await fs.readFile("version.txt", { encoding: "utf8" }));
if (!syncFs.existsSync("node")) {
  await spawnAsync(
    "git",
    ["clone", nodejsGithubRepo, "--branch", version, "--depth=1"],
    undefined,
    {}
  );
}

process.chdir("node");

let extraArgs = [];
if (process.platform == "win32") {
  await spawnAsync(".\\vcbuild.bat", [
    ARCH,
    "dll",
    "openssl-no-asm",
    "no-cctest",
  ]);
} else {
  if (ARCH === "arm64") {
    extraArgs.push("--with-arm-float-abi");
    extraArgs.push("hard");
    extraArgs.push("--with-arm-fpu");
    extraArgs.push("neon");
  }

  await spawnAsync("./configure", [
    "--shared",
    "--dest-cpu",
    ARCH,
    "--dest-os",
    OS,
    ...extraArgs,
  ]);
  await spawnAsync("make", [
    "-C",
    "out",
    "BUILDTYPE=Release",
    `-j${threadCount}`,
    "node",
    "libnode",
  ]);
}
