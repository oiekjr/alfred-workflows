import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const projectDirectory = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const workflowDirectory = path.join(
  projectDirectory,
  "workflows",
  "github-repositories",
);
const sourceRoots = [
  path.join(workflowDirectory, "src"),
  path.join(projectDirectory, "scripts"),
  path.join(projectDirectory, "test"),
];

for (const sourcePath of sourceRoots.flatMap(javaScriptSources)) {
  runChecked(process.execPath, ["--check", sourcePath]);
}

const launcherPath = path.join(workflowDirectory, "github-repositories");
runChecked("/bin/sh", ["-n", launcherPath]);
if ((statSync(launcherPath).mode & 0o111) !== 0) {
  throw new Error("workflow launcher must be interpreted as non-executable data");
}
runChecked("/usr/bin/plutil", [
  "-lint",
  path.join(workflowDirectory, "info.plist"),
]);

const packageDocument = JSON.parse(
  readFileSync(path.join(projectDirectory, "package.json"), "utf8"),
);
for (const dependencyField of [
  "dependencies",
  "devDependencies",
  "optionalDependencies",
]) {
  if (
    packageDocument[dependencyField] &&
    Object.keys(packageDocument[dependencyField]).length > 0
  ) {
    throw new Error("runtime and development npm dependencies are not allowed");
  }
}

/**
 * 指定ディレクトリ配下のJavaScriptソースを安定順で列挙する。
 *
 * @param {string} directory 検索対象ディレクトリ
 * @returns {string[]} `.mjs`または`.cjs`ソース一覧
 */
function javaScriptSources(directory) {
  const sources = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      sources.push(...javaScriptSources(entryPath));
    } else if (
      entry.isFile() &&
      (entry.name.endsWith(".mjs") || entry.name.endsWith(".cjs"))
    ) {
      sources.push(entryPath);
    }
  }
  return sources.sort();
}

/**
 * 子コマンドを継承なしで実行し、失敗時に診断を転送する。
 *
 * @param {string} command 実行ファイル絶対パス
 * @param {string[]} arguments_ 固定引数
 * @returns {void}
 */
function runChecked(command, arguments_) {
  const result = spawnSync(command, arguments_, {
    encoding: "utf8",
    env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", LC_ALL: "C" },
  });
  if (result.status !== 0) {
    process.stderr.write(result.stdout ?? "");
    process.stderr.write(result.stderr ?? "");
    throw new Error(`source validation failed: ${command}`);
  }
}
