// Service worker: toolbar button, right-click menus, optional auto-open of PDFs.

const VIEWER = chrome.runtime.getURL('viewer.html');
const viewerFor = (url) => `${VIEWER}?file=${encodeURIComponent(url)}`;

const PDF_URL = /\.pdf($|[?#])|^https?:\/\/(www\.)?arxiv\.org\/pdf\//i;

async function looksLikePdf(url) {
  if (!url || url.startsWith(VIEWER)) return false;
  if (PDF_URL.test(url)) return true;
  if (!/^https?:/.test(url)) return url.startsWith('file:') && /\.pdf$/i.test(url);
  try {
    const res = await fetch(url, { method: 'HEAD', credentials: 'include' });
    return /application\/pdf/i.test(res.headers.get('content-type') || '');
  } catch {
    return false;
  }
}

chrome.action.onClicked.addListener(async (tab) => {
  if (await looksLikePdf(tab.url)) chrome.tabs.update(tab.id, { url: viewerFor(tab.url) });
  else chrome.tabs.create({ url: VIEWER, index: tab.index + 1 });
});

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({ id: 'read-link', title: 'Read PDF aloud with PaperVoice', contexts: ['link'] });
    chrome.contextMenus.create({ id: 'read-page', title: 'Read this PDF aloud with PaperVoice', contexts: ['page'] });
  });
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === 'read-link' && info.linkUrl) {
    chrome.tabs.create({ url: viewerFor(info.linkUrl), index: tab ? tab.index + 1 : undefined });
  } else if (info.menuItemId === 'read-page' && tab?.url) {
    chrome.tabs.update(tab.id, { url: viewerFor(tab.url) });
  }
});

// Auto-open: when enabled in settings, PDF URLs are swapped for the reader.
// Add #noreader to a PDF URL to view it in the normal browser viewer.
let autoOpen = false;
chrome.storage.local.get('settings').then(({ settings }) => { autoOpen = !!settings?.autoOpen; });
chrome.storage.onChanged.addListener((changes) => {
  if (changes.settings) autoOpen = !!changes.settings.newValue?.autoOpen;
});

chrome.tabs.onUpdated.addListener((tabId, change) => {
  const url = change.url;
  if (!autoOpen || !url || url.includes('#noreader')) return;
  if (/^(https?|file):/.test(url) && PDF_URL.test(url)) chrome.tabs.update(tabId, { url: viewerFor(url) });
});
