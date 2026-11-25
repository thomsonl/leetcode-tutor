#!/usr/bin/env node
// leetcode-capture-helper install | update | uninstall | status
//
//   install [--chrome-id <id>]... [--browser <id>]... [--root <folder>]
//     Registers the helper with the browsers found for this user (or only the
//     ones named with --browser). Chrome, Chromium, Edge and Brave need the
//     extension's id, which the extension's settings page shows in the
//     command to copy. --root is the LeetCode Capture folder holding
//     companion/ and relay-server/ (by default the one this helper is in).
//   update     Run from a newer copy (npx leetcode-capture-helper@latest update):
//     registers that copy for the browsers and extension ids already set up,
//     keeping your settings. The helper does this by itself when a newer
//     version is out, unless you pass --no-auto-update (--auto-update turns it
//     back on; LEETCODE_CAPTURE_NO_AUTO_UPDATE=1 also stops it).
//   uninstall  Removes exactly what install wrote.
//   status     Shows what is registered where.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BROWSER_IDS, existingRegistration, install, readAutoUpdateChoice, status, uninstall } from './install.js';
import { recordResult } from './update.js';
import { VERSION } from './config.js';
import { resolveRoot } from './host.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));

export function parseArgs(argv) {
  const [command, ...rest] = argv;
  const options = { command, chromeIds: [], browsers: [], root: null, keepSettings: false, autoUpdate: null };
  for (let i = 0; i < rest.length; i += 1) {
    const flag = rest[i];
    const value = rest[i + 1];
    const take = () => {
      if (value === undefined || value.startsWith('--')) throw new Error(`${flag} needs a value`);
      i += 1;
      return value;
    };
    if (flag === '--chrome-id') options.chromeIds.push(...take().split(','));
    else if (flag === '--browser') options.browsers.push(...take().split(','));
    else if (flag === '--root') options.root = take();
    else if (flag === '--keep-settings') options.keepSettings = true;
    else if (flag === '--no-auto-update') options.autoUpdate = false;
    else if (flag === '--auto-update') options.autoUpdate = true;
    else throw new Error(`unknown option ${flag}`);
  }
  return options;
}

const USAGE = `usage: leetcode-capture-helper <install|update|uninstall|status> [options]

  install [--chrome-id <id>]... [--browser <${BROWSER_IDS.join('|')}>]... [--root <folder>] [--no-auto-update]
  update [--auto-update | --no-auto-update]
  uninstall [--keep-settings]
  status`;

export function run(argv, { home = os.homedir(), env = process.env, platform = process.platform, reg, print = console.log } = {}) {
  let options;
  try {
    options = parseArgs(argv);
  } catch (err) {
    print(`${err.message}\n\n${USAGE}`);
    return 2;
  }
  const common = { home, env, platform, ...(reg ? { reg } : {}) };
  try {
    if (options.command === 'install') {
      const result = install({
        ...common,
        root: options.root ? path.resolve(options.root) : resolveRoot(env, HERE),
        chromeIds: options.chromeIds,
        browsers: options.browsers.length ? options.browsers : null,
        autoUpdate: options.autoUpdate === null ? true : options.autoUpdate,
      });
      if (result.registered.length) print(`Registered the LeetCode Capture helper with: ${result.registered.join(', ')}.`);
      for (const note of result.notes) print(note);
      print(`Files are in ${result.dataDir}. Press Check again on the extension's settings page.`);
      return result.registered.length ? 0 : 1;
    }
    if (options.command === 'update') {
      const before = existingRegistration(common);
      if (!before.installed) {
        print('The helper is not installed, so there is nothing to update. Run install first.');
        return 1;
      }
      const result = install({
        ...common,
        root: options.root ? path.resolve(options.root) : resolveRoot(env, HERE),
        chromeIds: before.chromeIds,
        browsers: before.browsers.length ? before.browsers : null,
        autoUpdate: options.autoUpdate === null ? readAutoUpdateChoice(common) : options.autoUpdate,
      });
      recordResult({ dir: result.dataDir, ok: true, from: before.version, to: VERSION });
      print(before.version === VERSION ? `The helper is already at version ${VERSION}; registered again.` : `Updated the helper from ${before.version} to ${VERSION}. Your settings were kept.`);
      for (const note of result.notes) print(note);
      return result.registered.length ? 0 : 1;
    }
    if (options.command === 'uninstall') {
      const result = uninstall({ ...common, keepSettings: options.keepSettings });
      print(result.nothing ? 'The helper is not installed.' : `Removed the helper (${result.removed.length} items).`);
      if (result.leftover.length) {
        print(`Could not remove ${result.leftover.join(', ')} (in use). Close the browser, then run uninstall again.`);
        return 1;
      }
      return 0;
    }
    if (options.command === 'status') {
      const s = status(common);
      print(s.installed ? `Installed (version ${s.version}) in ${s.dataDir}` : 'Not installed.');
      if (s.root) print(`LeetCode Capture folder: ${s.root}${s.rootError ? ` (problem: ${s.rootError})` : ''}`);
      for (const b of s.browsers) print(`  ${b.label}: ${b.registered ? `registered for ${b.allowed.join(', ')}` : 'not registered'}`);
      return s.installed ? 0 : 1;
    }
  } catch (err) {
    print(`leetcode-capture-helper: ${err.message}`);
    return 1;
  }
  print(USAGE);
  return 2;
}

// npx and global installs run this through a symlink in node_modules/.bin.
if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = run(process.argv.slice(2));
}
