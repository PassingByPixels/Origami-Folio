/* origami-serve — serve a deck (or a folder of decks) over http://127.0.0.1 so
   referrer-gated embeds (YouTube, Power BI publish-to-web) play, which they
   cannot from a double-clicked file:// page.

     npx origami-serve my-deck.origami.html
     npx origami-serve ./decks --port 8080

   Read-only, loopback-only, no deps. Ctrl+C to stop. */

import { stat } from 'node:fs/promises';
import * as path from 'node:path';
import { createDeckServer, listenLoopback } from './server.js';

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  let port = 8787;
  let liveMode = false;
  const positional: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--port' || args[i] === '-p') {
      port = Number(args[++i]) || port;
    } else if (args[i] === '--live') {
      liveMode = true;
    } else if (args[i] === '--help' || args[i] === '-h') {
      process.stdout.write('Usage: origami-serve <deck.origami.html | folder> [--port N] [--live]\n');
      return;
    } else {
      positional.push(args[i]);
    }
  }
  const arg = positional[0] ?? '.';
  const resolved = path.resolve(arg);
  let info;
  try {
    info = await stat(resolved);
  } catch {
    process.stderr.write(`origami-serve: cannot find "${arg}"\n`);
    process.exitCode = 1;
    return;
  }

  const root = info.isDirectory() ? resolved : path.dirname(resolved);
  const indexFile = info.isDirectory() ? undefined : path.basename(resolved);
  const server = createDeckServer({ root, indexFile, live: liveMode });
  const boundPort = await listenLoopback(server, port);
  const url = `http://127.0.0.1:${boundPort}/`;

  process.stdout.write(`origami-serve${liveMode ? ' (live)' : ''}\n`);
  process.stdout.write(`  serving ${info.isDirectory() ? root : path.basename(resolved)}\n`);
  process.stdout.write(`  ${url}\n`);
  process.stdout.write(`  embeds that need an online origin (YouTube, Power BI) play here\n`);
  if (liveMode) process.stdout.write(`  live: the page rebuilds as the deck file changes\n`);
  process.stdout.write(`  Ctrl+C to stop\n`);

  const shutdown = () => {
    server.close(() => process.exit(0));
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((e) => {
  process.stderr.write(`origami-serve: ${(e as Error).message}\n`);
  process.exit(1);
});
