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

const forceWindowsStaticRuntime = async () => {
  const runtimeCondition = `['node_shared != "true"', {`;
  const commonGypiPath = "common.gypi";
  const configurePath = "configure.py";

  let commonGypi = await fs.readFile(commonGypiPath, { encoding: "utf8" });
  const runtimeConditionCount =
    commonGypi.split(runtimeCondition).length - 1;
  if (runtimeConditionCount < 2) {
    throw new Error(
      `Could not find expected MSVC runtime conditions in ${commonGypiPath}`
    );
  }
  commonGypi = commonGypi.replaceAll(runtimeCondition, `['1', {`);
  await fs.writeFile(commonGypiPath, commonGypi);

  let configure = await fs.readFile(configurePath, { encoding: "utf8" });
  const dynamicCrtAssignment =
    "o['variables']['force_dynamic_crt'] = 1 if options.shared else 0";
  if (!configure.includes(dynamicCrtAssignment)) {
    throw new Error(
      `Could not find expected force_dynamic_crt assignment in ${configurePath}`
    );
  }
  configure = configure.replace(
    dynamicCrtAssignment,
    "o['variables']['force_dynamic_crt'] = 0"
  );
  await fs.writeFile(configurePath, configure);
};

const forceWindowsVs2026 = async () => {
  const vcbuildPath = "vcbuild.bat";
  const nodeGypMsvsVersionPath =
    "deps/npm/node_modules/node-gyp/gyp/pylib/gyp/MSVSVersion.py";
  let vcbuild = await fs.readFile(vcbuildPath, { encoding: "utf8" });
  const replacements = [
    [
      'if /i "%1"=="vs2022"        set target_env=vs2022&goto arg-ok',
      'if /i "%1"=="vs2026"        set target_env=vs2026&goto arg-ok',
    ],
    [
      'if "%target_env%"=="vs2022" set "node_gyp_exe=%node_gyp_exe% --msvs_version=2022"',
      'if "%target_env%"=="vs2026" set "node_gyp_exe=%node_gyp_exe% --msvs_version=2026"',
    ],
    ["@rem Look for Visual Studio 2022", "@rem Look for Visual Studio 2026"],
    [":vs-set-2022", ":vs-set-2026"],
    [
      'if defined target_env if "%target_env%" NEQ "vs2022" goto msbuild-not-found',
      'if defined target_env if "%target_env%" NEQ "vs2026" goto msbuild-not-found',
    ],
    [
      "echo Looking for Visual Studio 2022",
      "echo Looking for Visual Studio 2026",
    ],
    [
      'call tools\\msvs\\vswhere_usability_wrapper.cmd "[17.6,18.0)" %target_arch% "prerelease" %clang_cl%',
      'call tools\\msvs\\vswhere_usability_wrapper.cmd "[18.0,19.0)" %target_arch% "prerelease" %clang_cl%',
    ],
    [
      'if "_%VCINSTALLDIR%_" == "__" goto msbuild-not-found',
      'if "_%VCINSTALLDIR%_" == "__" if exist "%ProgramFiles(x86)%\\Microsoft Visual Studio\\18\\BuildTools\\VC\\Auxiliary\\Build\\vcvarsall.bat" set "VCINSTALLDIR=%ProgramFiles(x86)%\\Microsoft Visual Studio\\18\\BuildTools\\VC\\"\nif "_%VCINSTALLDIR%_" == "__" goto msbuild-not-found',
    ],
    [
      'if "_%VisualStudioVersion%_" == "_17.0_" if "_%VSCMD_ARG_TGT_ARCH%_"=="_%target_arch%_" goto found_vs2022',
      'if "_%VisualStudioVersion%_" == "_18.0_" if "_%VSCMD_ARG_TGT_ARCH%_"=="_%target_arch%_" goto found_vs2026',
    ],
    [":found_vs2022", ":found_vs2026"],
    ["set GYP_MSVS_VERSION=2022", "set GYP_MSVS_VERSION=2026"],
    ["set PLATFORM_TOOLSET=v143", "set PLATFORM_TOOLSET=v180"],
    [
      "[vs2022] [download-all]",
      "[vs2026] [download-all]",
    ],
  ];

  for (const [from, to] of replacements) {
    if (!vcbuild.includes(from)) {
      if (vcbuild.includes(to)) {
        continue;
      }
      throw new Error(
        `Could not find expected VS 2022 marker in ${vcbuildPath}: ${from}`
      );
    }
    vcbuild = vcbuild.replace(from, to);
  }

  await fs.writeFile(vcbuildPath, vcbuild);

  let nodeGypMsvsVersion = await fs.readFile(nodeGypMsvsVersionPath, {
    encoding: "utf8",
  });
  const lineEnd = nodeGypMsvsVersion.includes("\r\n") ? "\r\n" : "\n";
  const addNodeGypSupport = (pattern, replacement) => {
    if (!pattern.test(nodeGypMsvsVersion)) {
      throw new Error(
        `Could not find expected VS 2022 marker in ${nodeGypMsvsVersionPath}: ${pattern}`
      );
    }
    nodeGypMsvsVersion = nodeGypMsvsVersion.replace(pattern, replacement);
  };

  if (!nodeGypMsvsVersion.includes('"2026": VisualStudioVersion(')) {
    addNodeGypSupport(
      /        "2022": VisualStudioVersion\(\r?\n            "2022",/,
      [
        '        "2026": VisualStudioVersion(',
        '            "2026",',
        '            "Visual Studio 2026",',
        '            solution_version="12.00",',
        '            project_version="18.0",',
        "            path=path,",
        "            sdk_based=sdk_based,",
        '            default_toolset="v180",',
        '            compatible_sdks=["v8.1", "v10.0"],',
        "        ),",
        '        "2022": VisualStudioVersion(',
        '            "2022",',
      ].join(lineEnd)
    );
  }

  if (!nodeGypMsvsVersion.includes('"18.0": "2026"')) {
    addNodeGypSupport(
      /        "17\.0": "2022",/,
      ['        "17.0": "2022",', '        "18.0": "2026",'].join(lineEnd)
    );
  }

  if (!nodeGypMsvsVersion.includes('"2026": ("18.0",)')) {
    addNodeGypSupport(
      /        "2022": \("17\.0",\),/,
      ['        "2022": ("17.0",),', '        "2026": ("18.0",),'].join(lineEnd)
    );
  }

  await fs.writeFile(nodeGypMsvsVersionPath, nodeGypMsvsVersion);
};

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
  await forceWindowsStaticRuntime();
  await forceWindowsVs2026();
  await spawnAsync(".\\vcbuild.bat", [
    ARCH,
    "dll",
    "vs2026",
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
