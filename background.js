chrome.sidePanel
  .setPanelBehavior({ openPanelOnActionClick: true })
  .catch((error) => console.error(error));

const FLOW_HOST_KEYWORDS = [
  'labs.google',
  'googleusercontent',
  'googlevideo',
  'gstatic',
  'googleapis',
  'google.com',
  'blob:',
  'data:'
];

let currentDownloadSubfolder = '';

// Filename queues per tab and global fallback queue
const fileNameQueues = new Map(); // tabId -> string[]
let globalFileNameQueue = [];
let lastActiveTabId = null;

// Direct download paths tracking
const directDownloadPathsByUrl = new Map();
const directDownloadPathsById = new Map();

function sanitizePathSegment(input) {
  return String(input || '')
    .replace(/[\\/:*?"<>|]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\.+/, '')
    .replace(/\.+$/, '');
}

function sanitizeSubfolderPath(input) {
  const normalized = String(input || '').replace(/\\+/g, '/');
  const segments = normalized
    .split('/')
    .map(segment => sanitizePathSegment(segment))
    .filter(Boolean);
  return segments.join('/');
}

function sanitizeFileName(input) {
  return String(input || '')
    .replace(/[\\/:*?"<>|]/g, '_')
    .replace(/\s+/g, '-')
    .trim()
    .replace(/^\.+/, '')
    .replace(/\.+$/, '');
}

function shouldHandleDownload(url, referrer) {
  if (globalFileNameQueue.length > 0) return true;
  for (const q of fileNameQueues.values()) {
    if (q && q.length > 0) return true;
  }
  const haystack = `${url || ''} ${referrer || ''}`.toLowerCase();
  return FLOW_HOST_KEYWORDS.some(keyword => haystack.includes(keyword));
}

async function hasDebuggerPermission() {
  try {
    return await chrome.permissions.contains({ permissions: ['debugger'] });
  } catch (error) {
    return false;
  }
}

async function loadFolderFromStorage() {
  try {
    const data = await chrome.storage.local.get(['veo_download_subfolder']);
    currentDownloadSubfolder = sanitizeSubfolderPath(data?.veo_download_subfolder || '');
  } catch (error) {
    currentDownloadSubfolder = '';
  }
}

loadFolderFromStorage();

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (!request || !request.action) return;

  if (request.action === 'SET_DOWNLOAD_SUBFOLDER') {
    const cleanFolder = sanitizeSubfolderPath(request.folder || '');
    currentDownloadSubfolder = cleanFolder;
    chrome.storage.local.set({ veo_download_subfolder: cleanFolder }).catch(() => { });
    sendResponse?.({ ok: true, folder: cleanFolder });
    return;
  }

  // content.js calls this action once per prompt, passing filename array for all outputs
  // e.g.: outputCount=2 -> sends ['01_dog-and-cat.mp4', '01_dog-and-cat.mp4']
  if (request.action === 'SET_NEXT_DOWNLOAD_NAMES') {
    const tabId = sender?.tab?.id || request.tabId;
    const names = Array.isArray(request.fileNames)
      ? request.fileNames.map(n => sanitizeFileName(n)).filter(Boolean)
      : [];

    if (tabId) {
      lastActiveTabId = tabId;
      const tabQueue = fileNameQueues.get(tabId) || [];
      tabQueue.push(...names);
      fileNameQueues.set(tabId, tabQueue);
    }
    globalFileNameQueue.push(...names);
    sendResponse?.({ ok: true, queued: globalFileNameQueue.length });
    return;
  }

  // Clear queue when starting a new batch
  if (request.action === 'CLEAR_FILENAME_QUEUE') {
    const tabId = sender?.tab?.id || request.tabId;
    if (tabId) {
      fileNameQueues.delete(tabId);
    }
    globalFileNameQueue = [];
    sendResponse?.({ ok: true });
    return;
  }

  // Pop filename from queue if download was cancelled or failed
  if (request.action === 'POP_FILENAME_QUEUE') {
    const tabId = sender?.tab?.id || request.tabId;
    let popped = null;
    if (tabId && fileNameQueues.has(tabId)) {
      const tabQueue = fileNameQueues.get(tabId);
      popped = tabQueue.shift();
      if (tabQueue.length === 0) fileNameQueues.delete(tabId);
    }
    if (!popped && globalFileNameQueue.length > 0) {
      popped = globalFileNameQueue.shift();
    } else if (popped) {
      const gIdx = globalFileNameQueue.indexOf(popped);
      if (gIdx !== -1) globalFileNameQueue.splice(gIdx, 1);
    }
    sendResponse?.({ ok: true, popped, remaining: globalFileNameQueue.length });
    return;
  }

  // Download file directly by URL (fallback when context menu click is unavailable)
  if (request.action === 'DOWNLOAD_FILE') {
    const rawFileName = sanitizeFileName(request.filename || 'download.png');
    const folder = sanitizeSubfolderPath(request.folder || currentDownloadSubfolder || '');
    const suggestedPath = folder ? `${folder}/${rawFileName}` : rawFileName;

    if (request.url) {
      directDownloadPathsByUrl.set(request.url, suggestedPath);
    }

    chrome.downloads.download({
      url: request.url,
      filename: suggestedPath,
      conflictAction: 'uniquify',
      saveAs: false
    }, (downloadId) => {
      if (chrome.runtime.lastError) {
        if (request.url) directDownloadPathsByUrl.delete(request.url);
        console.warn('[DOWNLOAD_FILE] Error:', chrome.runtime.lastError);
        sendResponse?.({ ok: false, error: chrome.runtime.lastError.message });
      } else {
        if (downloadId) directDownloadPathsById.set(downloadId, suggestedPath);
        sendResponse?.({ ok: true, downloadId });
      }
    });
    return true; // async sendResponse
  }

  if (request.action === 'TRUSTED_CLICK_AT' || request.action === 'TRUSTED_RIGHT_CLICK_AT') {
    const tabId = request.tabId || sender?.tab?.id;
    const x = Number(request.x);
    const y = Number(request.y);
    const isRightClick = request.action === 'TRUSTED_RIGHT_CLICK_AT';

    if (!tabId || !Number.isFinite(x) || !Number.isFinite(y)) {
      sendResponse?.({ ok: false, error: 'Invalid click payload' });
      return;
    }

    const runTrustedClick = async () => {
      if (!await hasDebuggerPermission()) {
        sendResponse?.({ ok: false, error: 'debugger permission is not enabled' });
        return;
      }

      if (!chrome.debugger) {
        sendResponse?.({ ok: false, error: 'chrome.debugger is not available' });
        return;
      }

      const target = { tabId };
      const button = isRightClick ? 'right' : 'left';

      try {
        await chrome.debugger.attach(target, '1.3');
        await chrome.debugger.sendCommand(target, 'Input.dispatchMouseEvent', {
          type: 'mousePressed',
          button,
          clickCount: 1,
          x,
          y
        });
        await chrome.debugger.sendCommand(target, 'Input.dispatchMouseEvent', {
          type: 'mouseReleased',
          button,
          clickCount: 1,
          x,
          y
        });
        await chrome.debugger.detach(target);
        sendResponse?.({ ok: true });
      } catch (error) {
        try { await chrome.debugger.detach(target); } catch (e) { }
        sendResponse?.({ ok: false, error: String(error?.message || error) });
      }
    };

    runTrustedClick();
    return true;
  }

  if (request.action === 'TRUSTED_INSERT_TEXT') {
    const tabId = request.tabId || sender?.tab?.id;
    const text = String(request.text || '');

    if (!tabId || !text) {
      sendResponse?.({ ok: false, error: 'Invalid insert text payload' });
      return;
    }

    const runInsertText = async () => {
      if (!await hasDebuggerPermission() || !chrome.debugger) {
        sendResponse?.({ ok: false, error: 'Debugger not available' });
        return;
      }
      const target = { tabId };
      try {
        await chrome.debugger.attach(target, '1.3');
        await chrome.debugger.sendCommand(target, 'Input.insertText', { text });
        await chrome.debugger.detach(target);
        sendResponse?.({ ok: true });
      } catch (error) {
        try { await chrome.debugger.detach(target); } catch (e) { }
        sendResponse?.({ ok: false, error: String(error?.message || error) });
      }
    };

    runInsertText();
    return true;
  }

  if (request.action === 'TRUSTED_KEY_EVENT') {
    const tabId = request.tabId || sender?.tab?.id;
    const key = request.key || 'Enter';
    const code = request.code || 'Enter';
    const keyCode = request.keyCode || 13;

    if (!tabId) {
      sendResponse?.({ ok: false, error: 'No tabId for key event' });
      return;
    }

    const runKeyEvent = async () => {
      if (!await hasDebuggerPermission() || !chrome.debugger) {
        sendResponse?.({ ok: false, error: 'Debugger not available' });
        return;
      }
      const target = { tabId };
      try {
        await chrome.debugger.attach(target, '1.3');
        await chrome.debugger.sendCommand(target, 'Input.dispatchKeyEvent', {
          type: 'rawKeyDown',
          key,
          code,
          windowsVirtualKeyCode: keyCode,
          nativeVirtualKeyCode: keyCode
        });
        await chrome.debugger.sendCommand(target, 'Input.dispatchKeyEvent', {
          type: 'keyUp',
          key,
          code,
          windowsVirtualKeyCode: keyCode,
          nativeVirtualKeyCode: keyCode
        });
        await chrome.debugger.detach(target);
        sendResponse?.({ ok: true });
      } catch (error) {
        try { await chrome.debugger.detach(target); } catch (e) { }
        sendResponse?.({ ok: false, error: String(error?.message || error) });
      }
    };

    runKeyEvent();
    return true;
  }

});

chrome.downloads.onDeterminingFilename.addListener((item, suggest) => {
  // Check if this download was initiated directly by DOWNLOAD_FILE
  let customDirectPath = null;
  if (item && item.id && directDownloadPathsById.has(item.id)) {
    customDirectPath = directDownloadPathsById.get(item.id);
    directDownloadPathsById.delete(item.id);
  } else if (item && item.url && directDownloadPathsByUrl.has(item.url)) {
    customDirectPath = directDownloadPathsByUrl.get(item.url);
    directDownloadPathsByUrl.delete(item.url);
  }

  if (customDirectPath) {
    const currentName = item?.filename || '';
    const origExtMatch = currentName.match(/\.([^.]+)$/);
    const origExt = origExtMatch ? origExtMatch[1] : '';
    if (origExt && !customDirectPath.endsWith('.' + origExt)) {
      customDirectPath = customDirectPath.replace(/\.[^.]+$/, '') + '.' + origExt;
    }
    suggest({ filename: customDirectPath, conflictAction: 'uniquify' });
    return;
  }

  const isFlowDownload = shouldHandleDownload(item?.url, item?.referrer);

  if (!isFlowDownload) {
    suggest();
    return;
  }

  const currentName = item?.filename || '';
  const origFileNameOnly = currentName.split('\\').pop().split('/').pop() || `download-${item.id}`;
  const extMatch = origFileNameOnly.match(/\.([^.]+)$/);
  const ext = extMatch ? extMatch[1] : '';

  // Get next filename from queue (prioritize active tab queue, fallback to global queue)
  let finalFileName = null;
  if (lastActiveTabId && fileNameQueues.has(lastActiveTabId)) {
    const tabQueue = fileNameQueues.get(lastActiveTabId);
    if (tabQueue && tabQueue.length > 0) {
      finalFileName = tabQueue.shift();
      if (tabQueue.length === 0) fileNameQueues.delete(lastActiveTabId);
      const gIdx = globalFileNameQueue.indexOf(finalFileName);
      if (gIdx !== -1) globalFileNameQueue.splice(gIdx, 1);
    }
  }

  if (!finalFileName && globalFileNameQueue.length > 0) {
    finalFileName = globalFileNameQueue.shift();
  }

  if (finalFileName) {
    finalFileName = finalFileName.endsWith('.' + ext)
      ? finalFileName
      : finalFileName.replace(/\.[^.]+$/, '') + (ext ? '.' + ext : '');
  } else {
    // Queue empty -> keep original filename
    finalFileName = origFileNameOnly;
  }

  const suggestedPath = currentDownloadSubfolder
    ? `${currentDownloadSubfolder}/${finalFileName}`
    : finalFileName;

  suggest({ filename: suggestedPath, conflictAction: 'uniquify' });
});
