"use strict";

const MINIMUM_NODE_MAJOR_VERSION = 22;
const INSTALL_OUTPUT = JSON.stringify({
  items: [
    {
      title: "Install Node.js 22 or later",
      subtitle: "Node.js is required to run GitHub Navigator.",
      arg: "https://nodejs.org/en/download",
      quicklookurl: "https://nodejs.org/en/download",
      valid: true,
      variables: { action: "open" },
    },
  ],
});
const FAILURE_OUTPUT = JSON.stringify({
  items: [
    {
      title: "Unable to load GitHub results",
      subtitle: "The workflow could not start its Node.js runtime.",
      valid: false,
    },
  ],
});

/**
 * 実行中Node.jsの検証後、同一プロセスでアプリケーションを開始する。
 *
 * @param {string[]} arguments_ Node.jsへ渡された利用者引数
 * @returns {Promise<number>} プロセス終了コード
 */
async function runBootstrap(arguments_) {
  if (!supportedNodeVersion(process.versions.node)) {
    process.stdout.write(INSTALL_OUTPUT);
    return 0;
  }

  try {
    const main = await import("./main.mjs");
    return await main.runMain(arguments_);
  } catch {
    process.stdout.write(FAILURE_OUTPUT);
    return 1;
  }
}

/**
 * Node.jsバージョンが実行要件を満たすか判定する。
 *
 * @param {string} version ドット区切りのNode.jsバージョン
 * @returns {boolean} Node.js 22以上の場合はtrue
 */
function supportedNodeVersion(version) {
  const majorField = version.split(".", 1)[0];
  if (!/^[0-9]+$/u.test(majorField)) {
    return false;
  }
  const majorVersion = Number(majorField);
  return (
    Number.isSafeInteger(majorVersion) &&
    majorVersion >= MINIMUM_NODE_MAJOR_VERSION
  );
}

module.exports = { runBootstrap, supportedNodeVersion };

if (require.main === module) {
  runBootstrap(process.argv.slice(2))
    .then((exitCode) => {
      process.exitCode = exitCode;
    })
    .catch(() => {
      process.stdout.write(FAILURE_OUTPUT);
      process.exitCode = 1;
    });
}
