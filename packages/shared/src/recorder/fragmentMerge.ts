import path from "node:path";
import fs from "node:fs/promises";

import { getUnusedFileName, uuid } from "../utils/index.js";
import logger from "../utils/log.js";
import { archiveToOld, rollbackMoves, type FileMove } from "./fragmentMergeArchive.js";
import {
  CommandTimeoutError,
  copyRemux,
  decodeAll,
  durationTolerance,
  fingerprintsMatch,
  mediaValidateOptions,
  probe,
  runCommand,
  type CommandRunner,
} from "./fragmentMergeFfmpeg.js";

export {
  COMMAND_TIMEOUT_MS,
  CommandTimeoutError,
  DURATION_TOLERANCE_MIN_SEC,
  DURATION_TOLERANCE_RATIO,
  MEDIA_VALIDATE_TIMEOUT_MAX_MS,
  durationTolerance,
  mediaValidateOptions,
  mediaValidateTimeoutMs,
  resolveCommandTimeoutMs,
  runCommand,
  type CommandRunner,
} from "./fragmentMergeFfmpeg.js";

export type FragmentProcessResult =
  | { readonly kind: "noop"; readonly reason: "empty" | "single-keep" | "capability-skip" }
  | { readonly kind: "remuxed"; readonly output: string; readonly durations: readonly number[] }
  | { readonly kind: "merged"; readonly output: string; readonly durations: readonly number[]; readonly archivedSources: readonly string[] }
  | { readonly kind: "rejected"; readonly reason: "mixed" | "truncated" | "ffmpeg" | "timeout" };

type ProcessFragmentsInput = {
  readonly files: readonly string[];
  readonly ffmpegPath: string;
  readonly ffprobePath: string;
  readonly run?: CommandRunner;
};

const COPY_EXTS = new Set([".mp4", ".ts", ".m4s", ".flv"]);

function extOf(file: string): string {
  return path.extname(file).toLowerCase();
}

function concatListLine(file: string): string {
  return `file '${file.replaceAll("'", "'\\''")}'`;
}

function tempSibling(output: string): string {
  const parsed = path.parse(output);
  return path.join(parsed.dir, `${parsed.name}.${uuid()}.partial${parsed.ext}`);
}

function rejectedFromCatch(
  error: unknown,
  message: string,
  context: Record<string, unknown>,
): FragmentProcessResult {
  if (error instanceof CommandTimeoutError) {
    logger.error(message, { ...context, error });
    return { kind: "rejected", reason: "timeout" };
  }
  if (error instanceof Error) {
    logger.error(message, { ...context, error });
    return { kind: "rejected", reason: "ffmpeg" };
  }
  throw error;
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function validateOutput(input: {
  readonly run: CommandRunner;
  readonly ffmpegPath: string;
  readonly ffprobePath: string;
  readonly output: string;
  readonly expectedDuration: number;
}): Promise<boolean> {
  if (!(await pathExists(input.output))) return false;
  const stat = await fs.stat(input.output);
  if (!stat.isFile() || stat.size <= 0) return false;
  const meta = await probe(input.run, input.ffprobePath, input.output, mediaValidateOptions(input.expectedDuration));
  if (meta.duration <= 0) return false;
  if (Math.abs(meta.duration - input.expectedDuration) > durationTolerance(input.expectedDuration)) {
    return false;
  }
  await decodeAll(input.run, input.ffmpegPath, input.output, mediaValidateOptions(Math.max(input.expectedDuration, meta.duration)));
  return true;
}

async function promoteTemp(tempFile: string, output: string): Promise<string> {
  await fs.rename(tempFile, output);
  return output;
}

async function discardTemp(tempFile: string): Promise<void> {
  try {
    await fs.rm(tempFile, { recursive: true, force: true });
  } catch (error) {
    if (error instanceof Error) {
      logger.warn("autoFragmentMerge temp cleanup failed", { tempFile, error });
      return;
    }
    throw error;
  }
}

async function remuxCopyToMp4(
  input: ProcessFragmentsInput,
  run: CommandRunner,
  source: string,
): Promise<FragmentProcessResult> {
  const parsed = path.parse(source);
  const output = await getUnusedFileName(path.join(parsed.dir, `${parsed.name}.mp4`));
  const tempFile = tempSibling(output);
  try {
    const sourceMeta = await probe(run, input.ffprobePath, source);
    await copyRemux(run, input.ffmpegPath, ["-i", source], tempFile);
    const ok = await validateOutput({
      run,
      ffmpegPath: input.ffmpegPath,
      ffprobePath: input.ffprobePath,
      output: tempFile,
      expectedDuration: sourceMeta.duration,
    });
    if (!ok) {
      await discardTemp(tempFile);
      return { kind: "rejected", reason: "truncated" };
    }
    return {
      kind: "remuxed",
      output: await promoteTemp(tempFile, output),
      durations: [sourceMeta.duration],
    };
  } catch (error) {
    await discardTemp(tempFile);
    return rejectedFromCatch(error, "autoFragmentMerge remux failed", { source });
  }
}

async function mergeCopy(
  input: ProcessFragmentsInput,
  run: CommandRunner,
  files: readonly string[],
): Promise<FragmentProcessResult> {
  const head = files[0];
  if (!head) return { kind: "noop", reason: "empty" };
  let tempFile: string | undefined;
  let listFile: string | undefined;
  let moves: readonly FileMove[] = [];
  try {
    const fingerprints = await Promise.all(files.map((file) => probe(run, input.ffprobePath, file)));
    const first = fingerprints[0];
    if (!first || fingerprints.some((item) => !fingerprintsMatch(first, item))) {
      return { kind: "rejected", reason: "mixed" };
    }
    const parsed = path.parse(head);
    const output = path.join(parsed.dir, `${parsed.name}${parsed.ext}`);
    const archived = await archiveToOld(files, output);
    moves = archived.moves;
    tempFile = tempSibling(output);
    listFile = `${tempFile}.concat.txt`;
    const expectedDuration = fingerprints.reduce((sum, item) => sum + item.duration, 0);
    await fs.writeFile(listFile, archived.archivedSources.map(concatListLine).join("\n"));
    await copyRemux(
      run,
      input.ffmpegPath,
      ["-f", "concat", "-safe", "0", "-i", listFile],
      tempFile,
    );
    const ok = await validateOutput({
      run,
      ffmpegPath: input.ffmpegPath,
      ffprobePath: input.ffprobePath,
      output: tempFile,
      expectedDuration,
    });
    await discardTemp(listFile);
    listFile = undefined;
    if (!ok) {
      await discardTemp(tempFile);
      tempFile = undefined;
      await rollbackMoves(moves);
      return { kind: "rejected", reason: "truncated" };
    }
    const promoted = await promoteTemp(tempFile, output);
    tempFile = undefined;
    return {
      kind: "merged",
      output: promoted,
      durations: fingerprints.map((item) => item.duration),
      archivedSources: archived.archivedSources,
    };
  } catch (error) {
    if (listFile) await discardTemp(listFile);
    if (tempFile) await discardTemp(tempFile);
    await rollbackMoves(moves);
    return rejectedFromCatch(error, "autoFragmentMerge merge failed", { files });
  }
}

async function isReadable(
  input: ProcessFragmentsInput,
  run: CommandRunner,
  file: string,
): Promise<boolean> {
  try {
    const meta = await probe(run, input.ffprobePath, file);
    await decodeAll(run, input.ffmpegPath, file, mediaValidateOptions(meta.duration));
    return true;
  } catch (error) {
    if (error instanceof Error) {
      logger.warn("autoFragmentMerge capability skip", { file, error });
      return false;
    }
    throw error;
  }
}

export async function processFragments(
  input: ProcessFragmentsInput,
): Promise<FragmentProcessResult> {
  const files = input.files;
  const run = input.run ?? runCommand;
  if (files.length === 0) return { kind: "noop", reason: "empty" };

  const exts = files.map(extOf);
  if (files.length === 1) {
    const ext = exts[0];
    if (ext === ".mp4" || ext === ".ts") return { kind: "noop", reason: "single-keep" };
    if (ext === ".m4s") {
      const readable = await isReadable(input, run, files[0]);
      return readable ? { kind: "noop", reason: "single-keep" } : { kind: "noop", reason: "capability-skip" };
    }
    if (ext === ".flv") return remuxCopyToMp4(input, run, files[0]);
    return { kind: "noop", reason: "single-keep" };
  }

  const uniqueExts = new Set(exts);
  if (uniqueExts.size !== 1 || ![...uniqueExts].every((ext) => COPY_EXTS.has(ext))) {
    return { kind: "rejected", reason: "mixed" };
  }
  if (uniqueExts.has(".flv")) return { kind: "noop", reason: "capability-skip" };
  if (uniqueExts.has(".m4s")) {
    const readable = await Promise.all(files.map((file) => isReadable(input, run, file)));
    if (readable.some((ok) => !ok)) return { kind: "noop", reason: "capability-skip" };
  }
  return mergeCopy(input, run, files);
}
