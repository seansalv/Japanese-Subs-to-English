#!/usr/bin/env node
/**
 * Helper script to create the standard subtitle folder structure.
 *
 * Usage:
 *   npx tsx scripts/scaffoldEpisode.ts <ShowSlug> <EpisodeNumber> [jaSource.srt] [enSource.srt]
 *
 * Example:
 *   npx tsx scripts/scaffoldEpisode.ts ChainsawMan 01 ./downloads/ep1.ja.srt ./downloads/ep1.en.srt
 */

import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  if (args.length < 2 || args.includes('-h') || args.includes('--help')) {
    printUsage();
    process.exit(args.length ? 0 : 1);
  }

  const [showSlug, episodeArg, jaSource, enSource] = args;
  const episodeId = formatEpisodeId(episodeArg);

  const showDir = resolve('subtitles', showSlug);
  const episodeDir = resolve(showDir, `episode${episodeId}`);
  const rawDir = resolve(episodeDir, 'raw');
  const cardsDir = resolve(episodeDir, 'cards');

  ensureDir(showDir);
  ensureDir(episodeDir);
  ensureDir(rawDir);
  ensureDir(cardsDir);

  const summary: string[] = [];

  if (jaSource) {
    const target = resolve(rawDir, `episode${episodeId}.ja.srt`);
    copyIntoPlace(jaSource, target);
    summary.push(`Japanese SRT copied to ${target}`);
  }

  if (enSource) {
    const target = resolve(rawDir, `episode${episodeId}.en.srt`);
    copyIntoPlace(enSource, target);
    summary.push(`English SRT copied to ${target}`);
  }

  console.log(`Episode scaffold ready at ${episodeDir}`);
  console.log(`- Raw files: ${rawDir}`);
  console.log(`- Card outputs: ${cardsDir}`);
  if (summary.length) {
    console.log(summary.map((line) => `  • ${line}`).join('\n'));
  }
}

function ensureDir(path: string): void {
  if (!existsSync(path)) {
    mkdirSync(path, { recursive: true });
  }
}

function copyIntoPlace(source: string, destination: string): void {
  const resolvedSource = resolve(source);
  if (!existsSync(resolvedSource)) {
    throw new Error(`Source file not found: ${source}`);
  }
  copyFileSync(resolvedSource, destination);
}

function formatEpisodeId(value?: string): string {
  if (!value) return '01';
  if (/^\d+$/.test(value)) {
    return value.padStart(2, '0');
  }
  return value.replace(/[^a-z0-9]/gi, '').toLowerCase();
}

function printUsage(): void {
  console.log(`Usage: npx tsx scripts/scaffoldEpisode.ts <ShowSlug> <EpisodeNumber> [ja.srt] [en.srt]

Examples:
  npx tsx scripts/scaffoldEpisode.ts ChainsawMan 01 ./downloads/ep1.ja.srt ./downloads/ep1.en.srt
  npx tsx scripts/scaffoldEpisode.ts ChainsawMan 02
`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : error);
  process.exit(1);
});

