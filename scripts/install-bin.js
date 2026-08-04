import fs from "fs-extra";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { once } from "node:events";
import * as tar from "tar";
import { SingleBar } from "cli-progress";
import JSZip from "jszip";

const configuredDownloadIdleTimeoutMs = Number(
  process.env.BILILIVE_TOOLS_DOWNLOAD_IDLE_TIMEOUT_MS ?? 180_000,
);

if (
  !Number.isFinite(configuredDownloadIdleTimeoutMs) ||
  configuredDownloadIdleTimeoutMs <= 0
) {
  throw new Error("BILILIVE_TOOLS_DOWNLOAD_IDLE_TIMEOUT_MS 必须是正数毫秒");
}

const DOWNLOAD_IDLE_TIMEOUT_MS = configuredDownloadIdleTimeoutMs;
const DOWNLOAD_LOW_SPEED_WINDOW_MS = 30_000;
const DOWNLOAD_LOW_SPEED_BYTES_PER_SECOND = 1024;
const DOWNLOAD_JOB_CONCURRENCY = 2;
const DOWNLOAD_CACHE_DIR = process.env.BILILIVE_TOOLS_DOWNLOAD_CACHE_DIR ?? "";

export function getDownloadUrls(url) {
  if (!url.startsWith("https://github.com/")) return [url];
  return [...getGitHubProxyPrefixes().map((prefix) => `${prefix}${url}`), url];
}

export function getGitHubProxyPrefixes() {
  const list =
    process.env.GITHUB_PROXY_PREFIXES ??
    process.env.GITHUB_PROXY_LIST ??
    process.env.GITHUB_PROXY_PREFIX ??
    "";
  return list
    .split(",")
    .map((prefix) => prefix.trim())
    .filter(Boolean);
}

function getDownloadFilename(url, options = {}) {
  return options.filename ?? path.basename(new URL(url).pathname);
}

function getDownloadTargetPath(url, destination, options = {}) {
  return path.join(destination, getDownloadFilename(url, options));
}

function getDownloadCachePath(url, options = {}) {
  if (!DOWNLOAD_CACHE_DIR) return undefined;
  return path.join(DOWNLOAD_CACHE_DIR, getDownloadFilename(url, options));
}

export function validateDownloadedFile(filePath) {
  const extension = path.extname(filePath).toLowerCase();
  const header = fs.readFileSync(filePath).subarray(0, 8);

  if (filePath.endsWith(".tar.gz") && !(header[0] === 0x1f && header[1] === 0x8b)) {
    throw new Error(`${filePath} 不是有效的 .tar.gz 文件`);
  }
  if (extension === ".zip" && !(header[0] === 0x50 && header[1] === 0x4b)) {
    throw new Error(`${filePath} 不是有效的 .zip 文件`);
  }
  if (extension === ".deb" && header.toString("utf8") !== "!<arch>\n") {
    throw new Error(`${filePath} 不是有效的 .deb 文件`);
  }
}

function isValidDownloadedFile(filePath) {
  if (!fs.existsSync(filePath)) return false;
  try {
    validateDownloadedFile(filePath);
    return true;
  } catch {
    fs.removeSync(filePath);
    return false;
  }
}

function reuseExistingDownload(filePath) {
  if (!isValidDownloadedFile(filePath)) return false;
  console.log(`复用已下载文件 ${filePath}`);
  return true;
}

function hasNonEmptyFile(filePath) {
  if (!fs.existsSync(filePath)) return false;
  const stat = fs.statSync(filePath);
  return stat.isFile() && stat.size > 0;
}

function reuseExistingBaseResources() {
  const requiredFiles = [
    "packages/app/resources/bin/ffmpeg",
    "packages/app/resources/bin/ffprobe",
    "packages/app/resources/icon.png",
  ];
  if (!requiredFiles.every(hasNonEmptyFile)) return false;
  if (process.platform === "linux" || process.platform === "darwin") {
    fs.chmodSync("packages/app/resources/bin/ffmpeg", 0o755);
    fs.chmodSync("packages/app/resources/bin/ffprobe", 0o755);
  }
  console.log("复用已有基础二进制资源");
  return true;
}

async function copyCachedDownload(cachePath, targetPath) {
  await fs.ensureDir(path.dirname(targetPath));
  await fs.copy(cachePath, targetPath);
  console.log(`复用下载缓存 ${cachePath}`);
}

async function storeDownloadCache(targetPath, cachePath) {
  await fs.ensureDir(path.dirname(cachePath));
  await fs.copy(targetPath, cachePath);
}

async function unzip(zipFile, destination) {
  const zip = new JSZip();
  const data = await zip.loadAsync(fs.readFileSync(zipFile));
  await Promise.all(
    Object.keys(data.files).map(async (filename) => {
      const file = data.files[filename];
      if (!file.dir) {
        const content = await file.async("nodebuffer");
        const filePath = path.join(destination, filename);
        fs.ensureDirSync(path.dirname(filePath));
        fs.writeFileSync(filePath, content);
        if (process.platform === "linux" || process.platform === "darwin") {
          fs.chmodSync(filePath, 0o755);
        }
      }
    }),
  );
  console.log("解压成功");
}

function untar(tarFile, destination) {
  fs.ensureDirSync(destination);
  tar.x({ file: tarFile, C: destination, sync: true });
  console.log("解压成功");
}

async function downloadFile(url, desc, options = {}) {
  const urls = getDownloadUrls(url);
  const targetPath = getDownloadTargetPath(url, desc, options);
  const cachePath = getDownloadCachePath(url, options);
  let lastError;

  if (reuseExistingDownload(targetPath)) return;
  if (cachePath !== undefined && reuseExistingDownload(cachePath)) {
    await copyCachedDownload(cachePath, targetPath);
    return;
  }

  for (const downloadUrl of urls) {
    const downloadTargetPath = getDownloadTargetPath(downloadUrl, desc, options);
    try {
      console.log(`实际下载地址 ${downloadUrl}`);
      await downloadWithProgress(downloadUrl, desc, options);
      validateDownloadedFile(downloadTargetPath);
      if (cachePath !== undefined) {
        await storeDownloadCache(downloadTargetPath, cachePath);
      }
      return;
    } catch (error) {
      lastError = error;
      fs.removeSync(downloadTargetPath);
      console.warn(`下载失败，尝试下一个地址: ${downloadUrl}`);
    }
  }

  throw lastError;
}

async function downloadWithProgress(url, desc, options = {}) {
  const targetPath = getDownloadTargetPath(url, desc, options);
  await fs.ensureDir(desc);
  const controller = new AbortController();
  let abortError;
  let downloadedBytes = 0;
  let previousDownloadedBytes = 0;
  let previousCheckAt = Date.now();
  const abortDownload = (message) => {
    abortError = new Error(message);
    controller.abort(abortError);
  };
  let idleTimer;
  const resetIdleTimer = () => {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(
      () => abortDownload(`单个下载地址超过 ${DOWNLOAD_IDLE_TIMEOUT_MS / 1000} 秒未收到数据`),
      DOWNLOAD_IDLE_TIMEOUT_MS,
    );
  };
  resetIdleTimer();
  const lowSpeedTimer = setInterval(() => {
    if (downloadedBytes === 0) return;
    const now = Date.now();
    const elapsedSeconds = (now - previousCheckAt) / 1000;
    const bytesPerSecond = (downloadedBytes - previousDownloadedBytes) / elapsedSeconds;
    previousCheckAt = now;
    previousDownloadedBytes = downloadedBytes;
    if (bytesPerSecond < DOWNLOAD_LOW_SPEED_BYTES_PER_SECOND) {
      abortDownload(`单个下载地址低速超过 ${DOWNLOAD_LOW_SPEED_WINDOW_MS / 1000} 秒`);
    }
  }, DOWNLOAD_LOW_SPEED_WINDOW_MS);
  const progressBar = new SingleBar({
    format: "下载进度 |{bar}| {percentage}% | ETA: {eta}s",
    barCompleteChar: "\u2588",
    barIncompleteChar: "\u2591",
    hideCursor: true,
  });
  progressBar.start(100, 0);
  try {
    const response = await fetch(url, { signal: controller.signal });
    resetIdleTimer();
    if (!response.ok) {
      throw new Error(`HTTP ${response.status} ${response.statusText}`);
    }
    if (!response.body) {
      throw new Error("响应体为空");
    }
    const totalBytes = Number(response.headers.get("content-length")) || 0;
    const output = fs.createWriteStream(targetPath);
    try {
      for await (const chunk of response.body) {
        downloadedBytes += chunk.length;
        resetIdleTimer();
        if (totalBytes > 0) {
          progressBar.update((downloadedBytes / totalBytes) * 100);
        }
        if (!output.write(chunk)) {
          await once(output, "drain");
        }
      }
      output.end();
      await once(output, "finish");
    } catch (error) {
      output.destroy();
      throw error;
    }
    console.log("\n下载成功");
  } catch (error) {
    throw abortError ?? error;
  } finally {
    clearTimeout(idleTimer);
    clearInterval(lowSpeedTimer);
    progressBar.stop();
  }
}

async function downloadMesio() {
  // https://github.com/hua0512/rust-srec
  const version = "mesio-v0.4.1";
  const destName = process.platform === "win32" ? "mesio.exe" : "mesio";
  const destPath = path.join("packages/app/resources/bin", destName);
  if (hasNonEmptyFile(destPath)) {
    console.log(`复用已有 mesio: ${destPath}`);
    if (process.platform === "linux" || process.platform === "darwin") {
      fs.chmodSync(destPath, 0o755);
    }
    return;
  }
  const mesioAssets = {
    "win32-x64": "mesio-x86_64-pc-windows-msvc.exe",
    "darwin-arm64": "mesio-aarch64-apple-darwin",
    "darwin-x64": "mesio-x86_64-apple-darwin",
    "linux-arm64": "mesio-aarch64-unknown-linux-musl",
    "linux-x64": "mesio-x86_64-unknown-linux-musl",
  };
  const target = `${process.platform}-${process.arch}`;
  const assetName = mesioAssets[target];

  if (!assetName) {
    throw new Error(`mesio ${version} 暂不支持平台: ${target}`);
  }

  const mesioUrl = `https://github.com/hua0512/rust-srec/releases/download/${version}/${assetName}`;
  await downloadFile(mesioUrl, "packages/app/resources/bin", {
    filename: destName,
  });
  // 添加执行权限
  if (process.platform === "linux" || process.platform === "darwin") {
    fs.chmodSync(destPath, 0o755);
  }
}

async function downloadBililiveRecorder() {
  // https://github.com/renmu123/BililiveRecorder/releases
  const cliPath = "packages/app/resources/bin/BililiveRecorder.Cli";
  if (hasNonEmptyFile(cliPath) || hasNonEmptyFile(`${cliPath}.exe`)) {
    console.log(`复用已有 BililiveRecorder: ${cliPath}`);
    if (process.platform === "linux" || process.platform === "darwin") {
      fs.chmodSync(cliPath, 0o755);
    }
    return;
  }
  const platforms = {
    win32: "win",
    darwin: "osx",
  };
  const platform = platforms[process.platform] ?? process.platform;
  const arch = process.arch;
  const filename = `BililiveRecorder-CLI-${platform}-${arch}.zip`;
  let url = `https://github.com/renmu123/BililiveRecorder/releases/download/v3.3.3/${filename}`;

  await downloadFile(url, ".");
  await unzip(filename, "packages/app/resources/bin");

  // 添加执行权限
  if (process.platform === "linux" || process.platform === "darwin") {
    fs.chmodSync(cliPath, 0o755);
  }
}

async function downloadAudioWaveform() {
  const version = "1.10.2";
  // https://github.com/bbc/audiowaveform
  const platforms = {
    win32: "win64",
    darwin: "macos",
    linux: "linux",
  };
  const archs = {
    x64: "amd64",
    arm64: "arm64",
  };
  const platform = platforms[process.platform] ?? process.platform;
  const arch = archs[process.arch] ?? process.arch;
  const baseUrl = `https://github.com/bbc/audiowaveform/releases/download/${version}`;
  let audioWaveformUrl = "";

  if (platform === "win64") {
    if (hasNonEmptyFile("packages/app/resources/bin/audiowaveform.exe")) {
      console.log("复用已有 audiowaveform.exe");
      return;
    }
    const filename = `audiowaveform-${version}-${platform}.zip`;
    audioWaveformUrl = `${baseUrl}/${filename}`;
    await downloadFile(audioWaveformUrl, ".");
    await unzip(filename, "packages/app/resources/bin");
  } else if (platform === "macos") {
    console.error("macOS 平台暂不支持 audiowaveform 下载，请手动安装");
    return;
  } else if (platform === "linux") {
    const debPath = "packages/app/resources/bin/audiowaveform.deb";
    if (hasNonEmptyFile(debPath)) {
      console.log(`复用已有 audiowaveform.deb: ${debPath}`);
      fs.chmodSync(debPath, 0o755);
      return;
    }
    console.warn("下载的是debian12版本");
    const filename = `audiowaveform_${version}-1-12_${arch}`;
    audioWaveformUrl = `${baseUrl}/${filename}.deb`;
    await downloadFile(audioWaveformUrl, "packages/app/resources/bin", {
      filename: "audiowaveform.deb",
    });
    fs.chmodSync(debPath, 0o755);
  }
}

async function downloadDanmakuFactory() {
  // https://github.com/renmu123/DanmakuFactory
  const binPath = "packages/app/resources/bin/DanmakuFactory";
  if (hasNonEmptyFile(binPath) || hasNonEmptyFile(`${binPath}.exe`)) {
    console.log(`复用已有 DanmakuFactory: ${binPath}`);
    if (process.platform === "linux") {
      fs.chmodSync(binPath, 0o755);
    }
    return;
  }

  let arch = process.arch;
  if (process.platform === "linux" || process.platform === "darwin") {
    if (arch === "x64") {
      arch = "x86_64";
    }
  }

  const platforms = {
    win32: "windows",
    darwin: "macosx",
  };
  const platform = platforms[process.platform] ?? process.platform;
  const filename = `DanmakuFactory-${platform}-${arch}-CLI.zip`;
  let url = `https://github.com/renmu123/DanmakuFactory/releases/download/v2.1.2/${filename}`;

  await downloadFile(url, ".");
  await unzip(filename, "packages/app/resources/bin");

  // 添加执行权限
  if (process.platform === "linux") {
    fs.chmodSync(binPath, 0o755);
  }
}

export async function downloadObscura() {
  const version = "v0.1.10";
  const destination = "packages/app/resources/bin";
  const obscuraBin = path.join(destination, process.platform === "win32" ? "obscura.exe" : "obscura");
  const workerBin = path.join(destination, process.platform === "win32" ? "obscura-worker.exe" : "obscura-worker");
  if (hasNonEmptyFile(obscuraBin)) {
    console.log(`复用已有 obscura: ${obscuraBin}`);
    if (process.platform === "linux" || process.platform === "darwin") {
      fs.chmodSync(obscuraBin, 0o755);
      if (hasNonEmptyFile(workerBin)) {
        fs.chmodSync(workerBin, 0o755);
      }
    }
    return;
  }
  const obscuraAssets = {
    "win32-x64": "obscura-x86_64-windows.zip",
    "darwin-arm64": "obscura-aarch64-macos.tar.gz",
    "darwin-x64": "obscura-x86_64-macos.tar.gz",
    "linux-arm64": "obscura-aarch64-linux.tar.gz",
    "linux-x64": "obscura-x86_64-linux.tar.gz",
  };
  const target = `${process.platform}-${process.arch}`;
  const assetName = obscuraAssets[target];

  if (!assetName) {
    throw new Error(`obscura ${version} 暂不支持平台: ${target}`);
  }

  const downloadUrl = `https://github.com/h4ckf0r0day/obscura/releases/download/${version}/${assetName}`;
  await downloadFile(downloadUrl, destination);

  const archivePath = path.join(destination, assetName);
  if (assetName.endsWith(".zip")) {
    await unzip(archivePath, destination);
  } else {
    untar(archivePath, destination);
  }

  if (process.platform === "linux" || process.platform === "darwin") {
    fs.chmodSync(path.join(destination, "obscura"), 0o755);
    fs.chmodSync(path.join(destination, "obscura-worker"), 0o755);
  }
}

export async function downloadBaseBinary() {
  if (reuseExistingBaseResources()) return;

  const filename = `${process.platform}-${process.arch}-2.5.0.zip`;
  const downloadUrl = `https://github.com/renmu123/biliLive-tools/releases/download/0.2.1/${filename}`;
  console.log(`下载 ${downloadUrl}`);

  await downloadFile(downloadUrl, ".");
  await unzip(filename, "packages/app/resources");
}

async function runWithConcurrency(tasks, concurrency) {
  let nextTaskIndex = 0;
  let firstError;
  const workerCount = Math.min(Math.max(1, concurrency), tasks.length);
  const workers = Array.from({ length: workerCount }, async () => {
    while (nextTaskIndex < tasks.length && firstError === undefined) {
      const task = tasks[nextTaskIndex];
      nextTaskIndex += 1;
      try {
        await task();
      } catch (error) {
        firstError ??= error;
      }
    }
  });

  await Promise.all(workers);
  if (firstError !== undefined) {
    throw firstError;
  }
}

export function getDefaultDownloadJobs() {
  return [
    downloadBaseBinary,
    downloadMesio,
    downloadBililiveRecorder,
    downloadAudioWaveform,
    downloadDanmakuFactory,
  ];
}

export async function downloadBin(downloadJobs = getDefaultDownloadJobs(), options = {}) {
  await runWithConcurrency(downloadJobs, options.concurrency ?? DOWNLOAD_JOB_CONCURRENCY);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  downloadBin();
}
