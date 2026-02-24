const STORAGE_KEY = 'sectionsData';

console.log('Background service worker starting...', new Date().toISOString());

async function ensureMainWorldInterceptorRegistered() {
  if (!chrome.scripting || !chrome.scripting.getRegisteredContentScripts) {
    console.warn('chrome.scripting API not available; cannot register MAIN world interceptor');
    return;
  }

  const id = 'ucam-sections-interceptor';
  try {
    const existing = await chrome.scripting.getRegisteredContentScripts({ ids: [id] });
    if (existing && existing.length > 0) return;

    await chrome.scripting.registerContentScripts([
      {
        id,
        matches: ['<all_urls>'],
        js: ['injected.js'],
        runAt: 'document_start',
        world: 'MAIN',
      },
    ]);

    console.log('Registered MAIN world interceptor');
  } catch (error) {
    console.warn('Failed to register MAIN world interceptor:', error);
  }
}

chrome.runtime.onInstalled.addListener(() => {
  ensureMainWorldInterceptorRegistered();
});

// Best-effort on worker startup as well.
ensureMainWorldInterceptorRegistered();

function parseDepartment(urlString) {
  try {
    const urlObj = new URL(urlString);
    const dep = urlObj.searchParams.get('department');
    return dep ? String(dep).trim() : null;
  } catch {
    return null;
  }
}

function isSectionsUrl(urlString) {
  if (typeof urlString !== 'string') return false;
  const lower = urlString.toLowerCase();
  return lower.includes('sections');
}

async function getStoredData() {
  const result = await chrome.storage.local.get({ [STORAGE_KEY]: [] });
  return Array.isArray(result[STORAGE_KEY]) ? result[STORAGE_KEY] : [];
}

async function setStoredData(next) {
  await chrome.storage.local.set({ [STORAGE_KEY]: next });
}

// Listen for messages
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (!request || typeof request.type !== 'string') {
    sendResponse({ success: false, error: 'Invalid request' });
    return false;
  }

  if (request.type === 'GET_DATA') {
    getStoredData()
      .then((data) => sendResponse({ data }))
      .catch((error) => sendResponse({ data: [], error: String(error) }));
    return true;
  }

  if (request.type === 'CLEAR_DATA') {
    setStoredData([])
      .then(() => sendResponse({ success: true }))
      .catch((error) => sendResponse({ success: false, error: String(error) }));
    return true;
  }

  if (request.type === 'CAPTURE_SECTIONS') {
    const url = request.url;
    const data = request.data;
    const timestamp = request.timestamp || new Date().toISOString();

    if (!isSectionsUrl(url)) {
      sendResponse({ success: false, error: 'Not a sections URL' });
      return false;
    }

    const newData = {
      timestamp,
      department: parseDepartment(url),
      url,
      data,
    };

    getStoredData()
      .then((existing) => {
        const next = existing.concat([newData]);
        return setStoredData(next).then(() => next.length);
      })
      .then((count) => {
        chrome.runtime.sendMessage({ type: 'NEW_DATA', count }).catch(() => {});
        sendResponse({ success: true, count });
      })
      .catch((error) => sendResponse({ success: false, error: String(error) }));

    return true;
  }

  sendResponse({ success: false, error: `Unknown message type: ${request.type}` });
  return false;
});