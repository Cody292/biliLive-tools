import path from "node:path";
import fs from "node:fs/promises";

import logger from "../utils/log.js";

export type FileMove = {
  readonly from: string;
  readonly to: string;
};

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

function siblingXmlPath(file: string): string {
  const parsed = path.parse(file);
  return path.join(parsed.dir, `${parsed.name}.xml`);
}

async function unusedArchivePair(
  oldDir: string,
  baseName: string,
  ext: string,
): Promise<{ readonly video: string; readonly xml: string }> {
  for (let n = 0; n <= 100; n += 1) {
    const tag = n === 0 ? "" : `(${n})`;
    const video = path.join(oldDir, `${baseName}${tag}${ext}`);
    const xml = path.join(oldDir, `${baseName}${tag}.xml`);
    if (!(await pathExists(video)) && !(await pathExists(xml))) {
      return { video, xml };
    }
  }
  throw new Error("文件名生成失败");
}

export async function rollbackMoves(moves: readonly FileMove[]): Promise<void> {
  for (const move of [...moves].reverse()) {
    try {
      if (!(await pathExists(move.to)) || (await pathExists(move.from))) continue;
      await fs.mkdir(path.dirname(move.from), { recursive: true });
      await fs.rename(move.to, move.from);
    } catch (error) {
      if (error instanceof Error) {
        logger.warn("autoFragmentMerge archive rollback failed", {
          from: move.from,
          to: move.to,
          error,
        });
        continue;
      }
      throw error;
    }
  }
}

export async function archiveToOld(
  files: readonly string[],
  output: string,
): Promise<{ readonly archivedSources: readonly string[]; readonly moves: FileMove[] }> {
  const oldDir = path.join(path.dirname(output), "old");
  const moves: FileMove[] = [];
  const moved = new Set<string>();

  const archiveOne = async (videoPath: string): Promise<string | undefined> => {
    const parsed = path.parse(videoPath);
    const xmlPath = siblingXmlPath(videoPath);
    const haveVideo = (await pathExists(videoPath)) && !moved.has(videoPath);
    const haveXml = (await pathExists(xmlPath)) && !moved.has(xmlPath);
    if (!haveVideo && !haveXml) return undefined;
    const dest = await unusedArchivePair(oldDir, parsed.name, parsed.ext);
    await fs.mkdir(oldDir, { recursive: true });
    if (haveVideo) {
      await fs.rename(videoPath, dest.video);
      moves.push({ from: videoPath, to: dest.video });
      moved.add(videoPath);
    }
    if (haveXml) {
      await fs.rename(xmlPath, dest.xml);
      moves.push({ from: xmlPath, to: dest.xml });
      moved.add(xmlPath);
    }
    return haveVideo ? dest.video : undefined;
  };

  try {
    const archivedSources: string[] = [];
    for (const file of files) {
      const archived = await archiveOne(file);
      archivedSources.push(archived ?? file);
    }
    await archiveOne(output);
    return { archivedSources, moves };
  } catch (error) {
    await rollbackMoves(moves);
    throw error;
  }
}
