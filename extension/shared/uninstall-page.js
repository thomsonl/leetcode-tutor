// The page the browser opens when the extension is removed from its own
// extensions page.
//
// An extension cannot run any code while it is being removed, so it cannot
// clean up the helper app (its files and its registration with the browser)
// itself. The one thing the browser offers is this page, opened in a tab
// after removal. It explains in one short step how to remove the helper. The
// browser deletes everything the extension stored (settings, keys, solved
// problems) by itself, and the helper's process ends when the browser closes
// its connection (helper/host.js), so the helper's files are all that is left.
//
// The address carries nothing about the user or the extension's version.
export const UNINSTALL_PAGE = 'https://github.com/thomsonl/leetcode-tutor#uninstall';

// `runtime` is browser.runtime or chrome.runtime. Returns true when the page
// was registered. Never throws: a browser without the call just skips it.
export function registerUninstallPage(runtime, url = UNINSTALL_PAGE) {
  try {
    if (!runtime || typeof runtime.setUninstallURL !== 'function') return false;
    const result = runtime.setUninstallURL(url);
    if (result && typeof result.catch === 'function') result.catch(() => {});
    return true;
  } catch {
    return false;
  }
}
