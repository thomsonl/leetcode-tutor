# Thomson's LeetCode Tutor

A browser extension that adds a Tutor tab to LeetCode problems. It gives hints and reviews your Submits, and tracks your progress.
Independent project, not affiliated with LeetCode.

## Install

The easy way: clone the repo and run the install script. It adds the extension to Chrome from the Web Store and sets up the helper for Claude and ChatGPT subscriptions. It needs Node.

```sh
git clone https://github.com/thomsonl/leetcode-capture.git
cd leetcode-capture
sh install.sh
```

On Windows: `powershell -ExecutionPolicy Bypass -File install.ps1`.
Then restart Chrome and click Enable.

## Install by hand

You need Node and Git.

```sh
git clone https://github.com/thomsonl/leetcode-capture.git
cd leetcode-capture
node extension/scripts/build.mjs --browser chrome
```

The last command prints where it put the Chrome build: the `dist/chrome` folder in the repo.
In PowerShell, git and npm print some normal progress in red (for example `NativeCommandError` or `npm warn exec`); that is not an error.

1. Open `chrome://extensions`, turn on Developer mode, click Load unpacked, and pick the `dist/chrome` folder.
   (The repo's own `extension/` folder also loads, but Chrome then shows a Warnings button about `background.scripts`, a key only Firefox uses; it is harmless.)
2. Open a problem on leetcode.com and click the Tutor tab.
   Chrome may ask whether leetcode.com may "access other apps and services on this device".
   Choose Allow: the page only talks to the tutor at `localhost:8135`, nothing else on your network.
3. Click the gear in the Tutor tab to open Settings, and choose a model.
   A local model (Ollama, LM Studio) or an API key needs nothing else: use "Add model", and fill in its settings.
   Settings save by themselves as you change them.
4. For a Claude or ChatGPT subscription, first sign in to `claude` or `codex` in a terminal.
   Choose the subscription in Settings, press "Allow starting the helper" in the Helper section, and choose Allow when Chrome asks.
   The extension restarts once to finish this; Settings and any open LeetCode tabs come back by themselves.
5. The Helper section now shows the install command, with your extension id filled in:

   ```sh
   npx leetcode-capture-helper install --chrome-id <your extension id>
   ```

   Run it in a terminal, press Check again, and once the Helper says Running, your choice is saved by itself.

## Update

The extension updates itself through your browser's store, and your settings, API keys and progress are kept across updates.
Each time the browser starts, the extension also asks the store for an update right away instead of waiting for the browser's own schedule, and reloads itself to take it once no Tutor tab or Settings page is open, so it never cuts off a reply.
The helper is a separate npm package, and from version 0.1.6 it keeps itself up to date.
The first time each browser session uses the helper (when you open a LeetCode problem), the extension has it ask the npm registry for the newest version.
If a newer one exists, it is installed before the helper is used, and the Tutor tab says "Updating the helper" meanwhile.
That takes a moment, and only happens when there is an update.
Otherwise the helper asks at most once a day, and installs a newer version by itself when nothing is using it (the browser closed, or the last LeetCode tab closed).
Either way it runs the same `npx` command you would run by hand.
Your saved helper settings are kept.

The Helper section in Settings shows the helper's version and lets you update right away, check again, or turn the automatic update off.
To update by hand, run this once (it reuses the browsers and extension id already set up):

```sh
npx leetcode-capture-helper@latest update
```

To stop automatic updates, untick the option in Settings, or install with `--no-auto-update`, or set `LEETCODE_CAPTURE_NO_AUTO_UPDATE=1`.
A helper older than 0.1.6 cannot update itself: run the install command from Settings again once, and it will from then on.
The extension tells you in Settings when its helper is too old for it.

## Uninstall

Remove the extension from `chrome://extensions` (or your browser's own extensions page).
The browser deletes everything the extension stored: your settings, API keys and solved problems.
If you never set up the helper (a local model or an API key does not use it), you are done.

If you did, run this once in a terminal to remove the helper from your computer:

```sh
npx leetcode-capture-helper uninstall
```

It removes the helper's files, its registration with your browsers, and its saved settings.
Add `--keep-settings` to keep the saved settings.
The helper stops by itself when the browser closes its connection, so removing the extension also ends its process.
Any notes the optional vault feature wrote are ordinary files in your vault; delete them like any other file.
