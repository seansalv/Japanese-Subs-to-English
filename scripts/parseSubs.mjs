#!/usr/bin/env node
/**
 * Minimal utility for turning an SRT subtitle file into:
 *  - a JSON array of card-friendly objects
 *  - a TSV file (front/back) that can be imported into Anki
 *
 * Usage:
 *   node scripts/parseSubs.mjs subtitles/<Show>/episodeXX/raw/episodeXX.ja.srt \
 *     [--json out.json] [--tsv out.tsv]
 *     --no-json    Skip writing the JSON output
 *     --no-tsv     Skip writing the TSV output
 *
 * Both outputs default to "<original>.cards.json/tsv" when not provided.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { basename, dirname, extname, resolve } from 'node:path';

const args = process.argv.slice(2);

if (!args.length || args.includes('-h') || args.includes('--help')) {
  printUsage();
  process.exit(args.length ? 0 : 1);
}

const inputPath = resolve(args[0]);
let options;
try {
  options = parseOptions(args.slice(1));
} catch (error) {
  console.error(error.message || error);
  process.exit(1);
}

const rawContent = readFileSync(inputPath, 'utf8');
const subtitles = parseSrt(rawContent);

if (!subtitles.length) {
  console.error(`No subtitle lines found in ${inputPath}.`);
  process.exit(1);
}

const cards = buildCards(subtitles);
console.log(`Parsed ${subtitles.length} subtitle blocks into ${cards.length} card entries.`);

if (options.writeJson) {
  const jsonPath =
    options.jsonPath ?? defaultOutPath(inputPath, '.cards.json');
  writeFileSync(jsonPath, JSON.stringify(cards, null, 2), 'utf8');
  console.log(`JSON output written to ${jsonPath}`);
}

if (options.writeTsv) {
  const tsvPath =
    options.tsvPath ?? defaultOutPath(inputPath, '.cards.tsv');
  writeFileSync(tsvPath, cardsToTsv(cards), 'utf8');
  console.log(`TSV output written to ${tsvPath}`);
}

/**
 * Convert an SRT file into structured subtitle entries.
 * @param {string} content
 * @returns {Array<{index:number,rawId:number,start:string|null,end:string|null,startMs:number|null,endMs:number|null,text:string}>}
 */
function parseSrt(content) {
  const normalized = content.replace(/\r\n/g, '\n').replace(/\uFEFF/g, '');
  const blocks = normalized.split(/\n{2,}/);
  const entries = [];

  for (const block of blocks) {
    const lines = block.split('\n');
    const meaningfulStart = lines.findIndex((line) => line.trim().length > 0);
    if (meaningfulStart === -1) continue;

    let cursor = meaningfulStart;
    const maybeId = Number.parseInt(lines[cursor].trim(), 10);
    let rawId;

    if (Number.isFinite(maybeId)) {
      rawId = maybeId;
      cursor += 1;
    } else {
      rawId = entries.length + 1;
    }

    let start = null;
    let end = null;

    if (cursor < lines.length && lines[cursor].includes('-->')) {
      const [startRaw, endRaw] = lines[cursor]
        .split('-->')
        .map((part) => part.trim());
      start = startRaw ?? null;
      end = endRaw ?? null;
      cursor += 1;
    }

    const textLines = lines
      .slice(cursor)
      .map((line) => line.replace(/\r/g, '').trim())
      .filter(Boolean);

    if (!textLines.length) continue;

    const text = textLines.join(' ');
    entries.push({
      index: entries.length + 1,
      rawId,
      start,
      end,
      startMs: timecodeToMs(start),
      endMs: timecodeToMs(end),
      text,
    });
  }

  return entries;
}

/**
 * Convert subtitle entries into card data.
 * @param {ReturnType<typeof parseSrt>} subtitles
 */
function buildCards(subtitles) {
  return subtitles.map((entry, idx) => ({
    id: idx + 1,
    subtitleId: entry.rawId,
    sentence: entry.text,
    translation: '',
    romaji: '',
    furigana: '',
    startTime: entry.start,
    endTime: entry.end,
    startMs: entry.startMs,
    endMs: entry.endMs,
  }));
}

/**
 * Transform cards into a TSV string ready for Anki import.
 * @param {Array<ReturnType<typeof buildCards>[number]>} cards
 */
function cardsToTsv(cards) {
  return cards
    .map((card) => `${clean(card.sentence)}\t${clean(card.translation)}`)
    .join('\n');
}

function clean(value) {
  return (value ?? '').replace(/\t/g, ' ').replace(/\r?\n/g, ' ').trim();
}

function timecodeToMs(timecode) {
  if (!timecode) return null;
  const match = timecode.match(/(\d{2}):(\d{2}):(\d{2}),(\d{3})/);
  if (!match) return null;
  const [, hh, mm, ss, ms] = match;
  return (
    Number(hh) * 3600 * 1000 +
    Number(mm) * 60 * 1000 +
    Number(ss) * 1000 +
    Number(ms)
  );
}

function parseOptions(tokens) {
  const opts = {
    jsonPath: null,
    tsvPath: null,
    writeJson: true,
    writeTsv: true,
  };

  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    switch (token) {
      case '--json':
        if (i + 1 >= tokens.length) {
          throw new Error('--json needs a file path argument.');
        }
        opts.jsonPath = resolve(tokens[++i]);
        break;
      case '--tsv':
        if (i + 1 >= tokens.length) {
          throw new Error('--tsv needs a file path argument.');
        }
        opts.tsvPath = resolve(tokens[++i]);
        break;
      case '--no-json':
        opts.writeJson = false;
        break;
      case '--no-tsv':
        opts.writeTsv = false;
        break;
      default:
        throw new Error(`Unknown option "${token}". Use --help for usage.`);
    }
  }

  if (!opts.writeJson && !opts.writeTsv) {
    throw new Error('At least one output (JSON or TSV) must be enabled.');
  }

  return opts;
}

function defaultOutPath(input, suffix) {
  const dir = dirname(input);
  const baseName = basename(input, extname(input));
  const normalizedBase = baseName.replace(/\.(ja|jp)$/i, '');

  let targetDir = dir;
  if (basename(dir).toLowerCase() === 'raw') {
    const parentDir = dirname(dir);
    targetDir = resolve(parentDir, 'cards');
    if (!existsSync(targetDir)) {
      mkdirSync(targetDir, { recursive: true });
    }
  }

  return resolve(targetDir, `${normalizedBase}${suffix}`);
}

function printUsage() {
  console.log(`Usage: node scripts/parseSubs.mjs <file.srt> [options]

Options:
  --json <path>    Custom path for the card JSON output
  --tsv <path>     Custom path for the TSV output
  --no-json        Skip writing the JSON file
  --no-tsv         Skip writing the TSV file
  -h, --help       Show this help text

Outputs default to "<input>.cards.json" and "<input>.cards.tsv".
`);
}
