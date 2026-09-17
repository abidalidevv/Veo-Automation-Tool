console.log("Office VEO Automation - Loaded into webpage.");


// ─────────────────────────────────────────────────────
// STEP 1 - Helper functions
// ─────────────────────────────────────────────────────

// STEP 1 - Helper functions
function buildFileName(stt, promptText, ext, autoRename) {
    const pad = String(stt).padStart(2, '0');
    const dotExt = '.' + (ext || 'png');

    if (!autoRename) {
        return pad + dotExt; // VD: 01.png
    }

    const slug = (promptText || '')
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')   // normalize accents
        .toLowerCase()
        .replace(/[^a-z0-9\s-]/g, '')
        .trim()
        .replace(/\s+/g, '-')
        .replace(/-+/g, '-')
        .slice(0, 30)                       // limit 30 characters
        .replace(/-$/, '');

    return slug ? (pad + '_' + slug + dotExt) : (pad + dotExt);    // VD: 01_a-cinematic-shot.png
}


function getAutoRenameState() {
    return new Promise(resolve => {
        try {
            chrome.storage.local.get(['veo_auto_rename'], result => {
                resolve(result.veo_auto_rename !== false);
            });
        } catch (e) { resolve(true); }
    });
}

const RUN_BUTTON_XPATH = '/html/body/div[1]/div[1]/div[5]/div/div/div/div/div[2]/div[2]/button[2]';
const MODE_TRIGGER_XPATH = '/html/body/div[1]/div[1]/div[5]/div/div/div/div/div[2]/div[2]/button[1]';
const PER_PROMPT_IMAGE_UPLOAD_XPATH = '/html/body/div[1]/div[1]/div[5]/div/div/div/div/div[2]/div[1]/div/button[1]';
const ASSET_IMAGES_TAB_XPATH = '/html/body/div[1]/div[2]/div/div/div/div/div[1]/nav/button[2]';
const runningGroups = new Map();
let imageAttachmentInProgress = false;  // Lock to serialize image picker operations
let promptProcessingInProgress = false;  // Lock to prevent next prompt's image selection until current prompt is submitted
let nativeAutoClickCache = null;

function getNativeAutoClickState() {
    return new Promise(resolve => {
        if (nativeAutoClickCache !== null) {
            resolve(nativeAutoClickCache);
            return;
        }

        try {
            chrome.storage.local.get(['veo_native_auto_click'], result => {
                nativeAutoClickCache = result.veo_native_auto_click === true;
                resolve(nativeAutoClickCache);
            });
        } catch (e) {
            nativeAutoClickCache = false;
            resolve(false);
        }
    });
}

try {
    chrome.storage?.onChanged?.addListener((changes, areaName) => {
        if (areaName === 'local' && changes.veo_native_auto_click) {
            nativeAutoClickCache = null; // Force re-fetch on next call
        }
    });
} catch (e) { }

async function requestTrustedClickAt(x, y) {
    if (!await getNativeAutoClickState()) {
        return { ok: false, error: 'native click fallback disabled' };
    }

    return new Promise(resolve => {
        try {
            chrome.runtime.sendMessage({ action: 'TRUSTED_CLICK_AT', x, y }, (resp) => {
                resolve({ ok: !!resp?.ok, error: resp?.error || '' });
            });
        } catch (e) {
            resolve({ ok: false, error: String(e?.message || e) });
        }
    });
}

async function requestTrustedRightClickAt(x, y) {
    if (!await getNativeAutoClickState()) {
        return { ok: false, error: 'native right-click fallback disabled' };
    }

    return new Promise(resolve => {
        try {
            chrome.runtime.sendMessage({ action: 'TRUSTED_RIGHT_CLICK_AT', x, y }, (resp) => {
                resolve({ ok: !!resp?.ok, error: resp?.error || '' });
            });
        } catch (e) {
            resolve({ ok: false, error: String(e?.message || e) });
        }
    });
}

function getBestClickPointForElement(element) {
    if (!element) return null;

    try {
        const icon = element.querySelector('i.google-symbols');
        if (icon) {
            const ir = icon.getBoundingClientRect();
            if (ir.width > 0 && ir.height > 0) {
                return {
                    x: Math.round(ir.left + ir.width / 2),
                    y: Math.round(ir.top + ir.height / 2)
                };
            }
        }
    } catch (e) { }

    try {
        const r = element.getBoundingClientRect();
        if (r.width > 0 && r.height > 0) {
            return {
                x: Math.round(r.left + r.width / 2),
                y: Math.round(r.top + r.height / 2)
            };
        }
    } catch (e) { }

    return null;
}

function getElementCenterPoint(element) {
    if (!element) return null;

    try {
        const rect = element.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) return null;

        return {
            x: Math.round(rect.left + rect.width / 2),
            y: Math.round(rect.top + rect.height / 2)
        };
    } catch (e) {
        return null;
    }
}

function addUniqueClickPoint(points, point, source) {
    if (!point || !Number.isFinite(point.x) || !Number.isFinite(point.y)) return;
    if (points.some(existing => Math.abs(existing.x - point.x) <= 3 && Math.abs(existing.y - point.y) <= 3)) return;
    points.push({ ...point, source });
}

function getRunClickPoints(submitButton, editor) {
    const points = [];

    addUniqueClickPoint(points, getBestClickPointForElement(submitButton), 'submit-element');

    const runButton = getElementByXPath(RUN_BUTTON_XPATH);
    addUniqueClickPoint(points, getElementCenterPoint(runButton), 'run-xpath');

    const modeButton = getElementByXPath(MODE_TRIGGER_XPATH);
    if (modeButton && isElementVisible(modeButton)) {
        try {
            const rect = modeButton.getBoundingClientRect();
            addUniqueClickPoint(points, {
                x: Math.round(rect.right + Math.max(28, rect.width * 0.45)),
                y: Math.round(rect.top + rect.height / 2)
            }, 'mode-button-relative');
        } catch (e) { }
    }

    const composer = getElementByXPath('/html/body/div[1]/div[1]/div[5]/div/div/div/div');
    const anchor = (composer && isElementVisible(composer)) ? composer : editor;
    if (anchor && isElementVisible(anchor)) {
        try {
            const rect = anchor.getBoundingClientRect();
            addUniqueClickPoint(points, {
                x: Math.round(rect.right - 34),
                y: Math.round(rect.bottom - 28)
            }, 'composer-bottom-right');
        } catch (e) { }
    }

    return points;
}

async function trustedClickRunFallback(submitButton, editor) {
    if (!await getNativeAutoClickState()) return false;

    const points = getRunClickPoints(submitButton, editor);
    if (points.length === 0) {
        console.log('[submit-debug] trusted run fallback skipped (no points)');
        return false;
    }

    let anyOk = false;
    for (const point of points) {
        const trustedResult = await requestTrustedClickAt(point.x, point.y);
        console.log(`[submit-debug] trusted run click (${point.source}) at ${point.x},${point.y} result=${trustedResult.ok}${trustedResult.error ? ` error=${trustedResult.error}` : ''}`);
        anyOk = trustedResult.ok || anyOk;
        await new Promise(r => setTimeout(r, 180));
    }

    return anyOk;
}

function createRunBridgeToken() {
    return `veo_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

async function triggerRunButtonByReactHandler(button) {
    if (!button || !isElementVisible(button)) return false;

    const token = createRunBridgeToken();
    const root = document.documentElement;

    try {
        button.setAttribute('data-veo-run-button-token', token);
        root.setAttribute('data-veo-run-token', token);
        root.removeAttribute('data-veo-run-result-token');
        root.removeAttribute('data-veo-run-result-ok');
        root.removeAttribute('data-veo-run-result-called');
        root.removeAttribute('data-veo-run-result-clicked');
    } catch (e) {
        return false;
    }

    const result = await new Promise(resolve => {
        let done = false;
        const finish = (value) => {
            if (done) return;
            done = true;
            document.removeEventListener('VEO_AUTOMATION_TRIGGER_RUN_REACT_RESULT', onResult);
            resolve(value);
        };

        const onResult = () => {
            const resultToken = root.getAttribute('data-veo-run-result-token') || '';
            if (resultToken !== token) return;

            const ok = root.getAttribute('data-veo-run-result-ok') === '1';
            const called = parseInt(root.getAttribute('data-veo-run-result-called') || '0', 10) || 0;
            const clicked = root.getAttribute('data-veo-run-result-clicked') === '1';
            finish({ ok, called, clicked });
        };

        document.addEventListener('VEO_AUTOMATION_TRIGGER_RUN_REACT_RESULT', onResult);

        try {
            document.dispatchEvent(new Event('VEO_AUTOMATION_TRIGGER_RUN_REACT'));
        } catch (e) {
            finish({ ok: false, called: 0, clicked: false });
            return;
        }

        setTimeout(() => finish({ ok: false, called: 0, clicked: false, timeout: true }), 900);
    });

    try {
        button.removeAttribute('data-veo-run-button-token');
        root.removeAttribute('data-veo-run-token');
    } catch (e) { }

    console.log(`[submit-debug] react bridge fallback ok=${result.ok} handlers=${result.called || 0} clicked=${!!result.clicked}${result.timeout ? ' timeout=true' : ''}`);
    return !!result.ok;
}

async function submitPromptByKeyboardFallback(editor, button = null) {
    const target = editor || getBestPromptEditor() || getBottomComposerEditor();
    if (!target) return false;

    try {
        target.scrollIntoView({ behavior: 'smooth', block: 'center' });
    } catch (e) { }

    try { target.focus(); } catch (e) { }
    try { target.click(); } catch (e) { }

    const dispatchTargets = [
        target,
        button,
        document.activeElement,
        document
    ].filter(Boolean);

    const combos = [
        { label: 'Enter', ctrlKey: false, metaKey: false },
        { label: 'Ctrl+Enter', ctrlKey: true, metaKey: false },
        { label: 'Meta+Enter', ctrlKey: false, metaKey: true }
    ];

    let dispatched = false;
    for (const combo of combos) {
        for (const eventTarget of dispatchTargets) {
            for (const type of ['keydown', 'keypress', 'keyup']) {
                try {
                    eventTarget.dispatchEvent(new KeyboardEvent(type, {
                        key: 'Enter',
                        code: 'Enter',
                        keyCode: 13,
                        which: 13,
                        bubbles: true,
                        cancelable: true,
                        composed: true,
                        ctrlKey: combo.ctrlKey,
                        metaKey: combo.metaKey,
                        view: window
                    }));
                    dispatched = true;
                } catch (e) { }
            }
        }
        console.log(`[submit-debug] keyboard fallback sent ${combo.label}`);
        await new Promise(r => setTimeout(r, 260));
    }

    return dispatched;
}

function hideManualRunHint() {
    ['veo-manual-run-style', 'veo-manual-run-hint', 'veo-manual-run-ring'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.remove();
    });
}

function showManualRunHint(button) {
    hideManualRunHint();
}

async function waitForManualRunAcceptance(editor, promptText, beforeErrorCount, beforeGridSnapshot, failureIdsBeforeSubmit, button, groupId, index, timeoutMs = 90000) {
    hideManualRunHint();
    return { accepted: false, promptRequiredError: false, flowFailure: false, reason: 'manual-run-disabled' };
}
// Message listener from Popup
// ==========================================
// TRACK RENDERING PROGRESS IN POPUP
// ==========================================
function monitorPopupProgress(groupId, promptIndex) {
    return new Promise((resolve) => {
        let attempts = 0;
        // Progress XPath
        const progressXPath = "/html/body/div[1]/div[1]/div[1]/div[2]/div/div/div[2]/div[1]/div/div[1]/div[3]/div/div[1]/div";
        // Expand button XPath to check completion
        const extendBtnXPath = "/html/body/div[1]/div[1]/div[1]/div[2]/div/div/div[2]/div[2]/div/div[2]/div/button[1]";

        const interval = setInterval(() => {
            attempts++;
            if (attempts > 400) { clearInterval(interval); resolve(false); return; }

            const progressEl = document.evaluate(progressXPath, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue;
            let myPercentValue = null;

            if (progressEl) {
                const text = progressEl.textContent.trim();
                const match = text.match(/(\d+)%/); // Match percentage number
                if (match) {
                    myPercentValue = parseInt(match[1]);
                }
            }

            const safeSendMessage = (msgPayload) => {
                try { chrome.runtime?.sendMessage(msgPayload).catch(() => { }); } catch (e) { }
            };

            if (myPercentValue !== null) {
                createOrUpdateProgressBar(myPercentValue);
                safeSendMessage({ action: "UPDATE_QUEUE_STATUS", groupId: groupId, index: promptIndex, status: `Rendering: ${myPercentValue}% 🚀`, percent: myPercentValue });

                if (myPercentValue >= 100) {
                    safeSendMessage({ action: "UPDATE_QUEUE_STATUS", groupId: groupId, index: promptIndex, status: "Done ✅", percent: 100 });
                    createOrUpdateProgressBar(100);
                    clearInterval(interval);
                    resolve(true);
                }
            } else {
                // Check if extend button is visible again -> Render complete
                const extendBtn = document.evaluate(extendBtnXPath, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue;
                if (attempts > 10 && extendBtn && isElementVisible(extendBtn) && !extendBtn.disabled) {
                    safeSendMessage({ action: "UPDATE_QUEUE_STATUS", groupId: groupId, index: promptIndex, status: "Done ✅", percent: 100 });
                    createOrUpdateProgressBar(100);
                    clearInterval(interval);
                    resolve(true);
                } else {
                    safeSendMessage({ action: "UPDATE_QUEUE_STATUS", groupId: groupId, index: promptIndex, status: "Preparing... ⚙️", percent: 0 });
                }
            }
        }, 1500);
    });
}



// autoDownloadResult handler:
// autoDownloadResult implementation:

async function autoDownloadResult(promptNumber, folderName, isVideo = true, selectedQuality = 'none', resultCard = null) {
    if (selectedQuality === 'none') return false;
    if (!resultCard) return false;

    const autoRename = await getAutoRenameState();
    const promptText = (window._promptRegistry && window._promptRegistry[promptNumber - 1]) || '';
    const ext = isVideo ? 'mp4' : 'png';
    const newFileName = buildFileName(promptNumber, promptText, ext, autoRename);

    // Make sure background.js knows the target folder
    if (folderName) {
        try {
            await chrome.runtime.sendMessage({
                action: 'SET_DOWNLOAD_SUBFOLDER',
                folder: folderName
            });
        } catch (e) { }
    }

    try {
        // Always target the specific resultCard and its media element
        const clickTarget = resultCard.querySelector('img, video, canvas, a') || resultCard;
        const rect = clickTarget.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) {
            console.warn(`[autoDownload] Card #${promptNumber} has 0 dimensions, attempting direct download if image`);
            if (!isVideo) {
                const img = resultCard.querySelector('img');
                if (img && img.src) {
                    return await triggerDirectDownload(img.src, newFileName, folderName, promptNumber);
                }
            }
            return false;
        }

        const cx = rect.left + rect.width / 2;
        const cy = rect.top + rect.height / 2;

        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        await new Promise(r => setTimeout(r, 200));

        forceUserLikeClick(clickTarget);
        await new Promise(r => setTimeout(r, 120));

        const trustedRightClick = await requestTrustedRightClickAt(cx, cy);
        console.log(`[autoDownload] trusted right click result=${trustedRightClick.ok}${trustedRightClick.error ? ` error=${trustedRightClick.error}` : ''}`);
        await new Promise(r => setTimeout(r, 450));

        clickTarget.dispatchEvent(new MouseEvent('contextmenu', {
            bubbles: true, cancelable: true, view: window,
            button: 2, buttons: 2, clientX: cx, clientY: cy
        }));
        await new Promise(r => setTimeout(r, 1000));

        // Try to find download button
        let downloadBtn = findDownloadMenuButtonV2() || findDownloadMenuButton();

        if (!downloadBtn || !isElementVisible(downloadBtn)) {
            const altXPaths = [
                '/html/body/div[1]/div[2]/div[2]/div/div[1]/div',
                '/html/body/div[2]/div[2]/div[2]/div/div[2]/div',
            ];
            for (const altXPath of altXPaths) {
                const alt = getElementByXPath(altXPath);
                if (alt && isElementVisible(alt)) {
                    downloadBtn = alt;
                    break;
                }
            }
        }

        if (downloadBtn && isElementVisible(downloadBtn)) {
            console.log('[autoDownload] ✓ Download button found, clicking...');
            forceUserLikeClick(downloadBtn);
            await new Promise(r => setTimeout(r, 1200)); // Wait for quality submenu to appear

            // Try to find quality button by text or xpath
            let qualityBtn = null;
            const targetQualityText = (selectedQuality || '').toLowerCase(); // e.g. "1k", "720p"

            // 1. Search visible buttons by text content
            const allButtons = Array.from(document.querySelectorAll('button, [role="menuitem"], [role="button"]'))
                .filter(b => isElementVisible(b));

            for (const btn of allButtons) {
                const bText = (btn.textContent || '').trim().toLowerCase();
                if (bText === targetQualityText || bText.includes(targetQualityText)) {
                    qualityBtn = btn;
                    console.log(`[autoDownload] ✓ Found quality button by text '${targetQualityText}'`);
                    break;
                }
            }

            // 2. Fallback to index-based xpath
            if (!qualityBtn) {
                const qualityIndexMap = isVideo
                    ? { '270p': 1, '720p': 2, '720k': 2, '1080p': 3, '1080k': 3, '4k': 4 }
                    : { '1k': 1, '2k': 2, '4k': 3 };
                const btnIndex = qualityIndexMap[targetQualityText];
                if (btnIndex) {
                    qualityBtn = getElementByXPath(`/html/body/div[3]/div/button[${btnIndex}]`);
                    if (!qualityBtn || !isElementVisible(qualityBtn)) {
                        const altQualityXPaths = [
                            `/html/body/div[1]/div[2]/div[2]/div/div[3]/div/button[${btnIndex}]`,
                            `/html/body/div[1]/div[2]/div[2]/div/div[2]/div/button[${btnIndex}]`,
                            `/html/body/div[2]/div[2]/div[2]/div/div[3]/div/button[${btnIndex}]`,
                        ];
                        for (const altXPath of altQualityXPaths) {
                            const alt = getElementByXPath(altXPath);
                            if (alt && isElementVisible(alt)) {
                                qualityBtn = alt;
                                break;
                            }
                        }
                    }
                }
            }

            if (qualityBtn && isElementVisible(qualityBtn)) {
                // Queue the specific filename before clicking download
                try {
                    await chrome.runtime.sendMessage({
                        action: 'SET_NEXT_DOWNLOAD_NAMES',
                        fileNames: [newFileName]
                    });
                } catch (e) { }

                console.log(`[autoDownload] ✓ Clicking quality button for prompt #${promptNumber} (${newFileName})`);
                forceUserLikeClick(qualityBtn);
                await new Promise(r => setTimeout(r, 600));
                return true;
            }
        }

        // Direct image download fallback if context menu didn't work
        if (!isVideo) {
            const img = resultCard.querySelector('img');
            if (img && img.src) {
                try {
                    await chrome.runtime.sendMessage({ action: 'POP_FILENAME_QUEUE' });
                } catch (e) { }
                console.log(`[autoDownload] Fallback: Direct image download from src for prompt #${promptNumber}`);
                return await triggerDirectDownload(img.src, newFileName, folderName, promptNumber);
            }
        }

        console.warn(`[autoDownload] ✗ Could not download for prompt #${promptNumber}`);
        return false;

    } catch (error) {
        console.error('[autoDownload] Error:', error);
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        // Direct download fallback on error
        if (!isVideo && resultCard) {
            const img = resultCard.querySelector('img');
            if (img && img.src) {
                try {
                    await chrome.runtime.sendMessage({ action: 'POP_FILENAME_QUEUE' });
                } catch (e) { }
                return await triggerDirectDownload(img.src, newFileName, folderName, promptNumber);
            }
        }
        return false;
    }
}

async function triggerDirectDownload(url, filename, folder, promptNumber) {
    try {
        const resp = await new Promise(resolve => {
            chrome.runtime.sendMessage({
                action: 'DOWNLOAD_FILE',
                url: url,
                filename: filename,
                folder: folder
            }, resolve);
        });
        if (resp && resp.ok) {
            console.log(`[autoDownload] ✓ Direct download succeeded for prompt #${promptNumber} -> ${filename}`);
            return true;
        }
    } catch (e) {
        console.warn('[autoDownload] triggerDirectDownload failed:', e);
    }
    return false;
}
// ==========================================
// WEBPAGE DOM MANIPULATION HELPERS
// ==========================================

// Helper function to query element by XPath
function getElementByXPath(xpath) {
    return document.evaluate(xpath, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue;
}

// Helper function to find download menu button more robustly
function findDownloadMenuButton() {
    // Try to find any visible menu item or button that looks like a download option
    const allElements = document.querySelectorAll('[role="menuitem"], [role="button"], div[class*="download"], div[class*="menu"]');

    for (const el of allElements) {
        if (!isElementVisible(el)) continue;

        // Check text content for "Download" or similar
        const text = normalizeUiText(el.textContent || '');
        if (text.includes('download') ) {
            return el;
        }

        // Check for download-related classes or attributes
        const html = normalizeUiText(el.outerHTML || '');
        if (html.includes('download') ) {
            return el;
        }
    }

    // If text search fails, return the most common download menu structure
    return getElementByXPath('/html/body/div[1]/div[2]/div[2]/div/div[2]/div');
}

/**
 * Generate XPath pattern with variable values
 * Supports dynamic variable substitution for flexible element discovery
 * Example: generateXPathVariants('/html/body/div[{A}]/div/div[{B}]', {A: [1,2], B: [3,4]})
 * Returns: ['/html/body/div[1]/div/div[3]', '/html/body/div[1]/div/div[4]', '/html/body/div[2]/div/div[3]', '/html/body/div[2]/div/div[4]']
 */
function findDownloadMenuButtonV2() {
    const allElements = document.querySelectorAll('[role="menuitem"], [role="button"], button, div[class*="download"], div[class*="menu"]');

    for (const el of allElements) {
        if (!isElementVisible(el)) continue;

        const text = normalizeUiText(el.textContent || '');
        const aria = normalizeUiText(el.getAttribute('aria-label') || '');
        const title = normalizeUiText(el.getAttribute('title') || '');
        const html = normalizeUiText(el.outerHTML || '');
        const haystack = `${text} ${aria} ${title} ${html}`;

        if (haystack.includes('download') || haystack.includes('tai xuong') || haystack.includes('tai ve') || haystack.includes('tai')) {
            return el;
        }
    }

    return null;
}

function isFlowPendingText(text) {
    const normalized = normalizeUiText(text || '');
    if (!normalized) return false;
    if (/\d{1,3}%/.test(normalized)) return true;

    const pendingKeywords = [
        'queue', 'queued', 'pending', 'preparing', 'processing', 'render', 'rendering',
        'loading', 'generating', 'creating video', 'creating videos', 'almost finished',
        'dang render', 'dang tao', 'dang chuan bi', 'chuan bi', 'dang cho', 'hang doi'
    ];

    return pendingKeywords.some(keyword => normalized.includes(keyword));
}

function isFlowFailureText(text) {
    const normalized = normalizeUiText(text || '');
    if (!normalized) return false;

    return normalized.includes('khong thanh cong')
        || normalized.includes('not successful')
        || normalized.includes('unsuccessful');
}

function getFlowFailureCardId(card) {
    if (!card) return '';
    return card.getAttribute?.('data-tile-id') || '';
}

function getVisibleFlowFailureCards(excludeIds = null) {
    const cards = new Map();
    Array.from(document.querySelectorAll('[data-tile-id]'))
        .filter(el => isElementVisible(el))
        .filter(el => isFlowFailureText(el.textContent || ''))
        .forEach(el => {
            const card = el.closest('[data-tile-id]') || el;
            const id = card.getAttribute('data-tile-id') || `${card.getBoundingClientRect().top}:${card.getBoundingClientRect().left}`;
            if (excludeIds && id && excludeIds.has(id)) return;
            cards.set(id, card);
        });

    return Array.from(cards.values()).filter(card => {
        const rect = card.getBoundingClientRect();
        return rect.width > 120 && rect.height > 80;
    });
}

function getVisibleFlowFailureIds() {
    return new Set(
        getVisibleFlowFailureCards()
            .map(card => getFlowFailureCardId(card))
            .filter(Boolean)
    );
}

function getPromptRetryKey(groupId, index) {
    return `${String(groupId)}:${Number(index)}`;
}

function markPromptRenderFailure(groupId, index) {
    monitorVideoProgress._renderFailurePrompts = monitorVideoProgress._renderFailurePrompts || new Set();
    monitorVideoProgress._renderFailurePrompts.add(getPromptRetryKey(groupId, index));
}

function consumePromptRenderFailure(groupId, index) {
    const key = getPromptRetryKey(groupId, index);
    const store = monitorVideoProgress._renderFailurePrompts;
    const hasFailure = !!(store && store.has(key));
    if (store) store.delete(key);
    return hasFailure;
}

function getRetryButtonFromFailureCard(card) {
    if (!card) return null;

    const buttons = Array.from(card.querySelectorAll('button, [role="button"]'))
        .filter(el => isElementVisible(el) && !el.disabled && el.getAttribute('aria-disabled') !== 'true');

    return buttons.find(btn => {
        const text = normalizeUiText(btn.textContent || '');
        const aria = normalizeUiText(btn.getAttribute('aria-label') || '');
        const title = normalizeUiText(btn.getAttribute('title') || '');
        const icon = normalizeUiText(Array.from(btn.querySelectorAll('i, .google-symbols, .material-icons')).map(i => i.textContent || '').join(' '));
        const haystack = `${text} ${aria} ${title} ${icon}`;
        return haystack.includes('refresh') || haystack.includes('retry') || haystack.includes('try again') || haystack.includes('lam lai') || haystack.includes('thu lai');
    }) || null;
}

async function clickFailureRetryButton(excludeIds = null) {
    const cards = getVisibleFlowFailureCards(excludeIds);
    if (cards.length === 0) return false;

    const newestCard = cards
        .sort((a, b) => b.getBoundingClientRect().top - a.getBoundingClientRect().top)[0];
    const retryButton = getRetryButtonFromFailureCard(newestCard);
    if (!retryButton) return false;

    retryButton.scrollIntoView({ behavior: 'smooth', block: 'center' });
    await new Promise(r => setTimeout(r, 300));
    forceUserLikeClick(retryButton);
    await trustedClickRunFallback(retryButton, null);
    await new Promise(r => setTimeout(r, 1000));
    return true;
}

function generateXPathVariants(pattern, variables) {
    const varNames = Object.keys(variables);
    if (varNames.length === 0) return [pattern];

    const combinations = [];

    // Generate all combinations
    const generateCombos = (index, currentValues) => {
        if (index === varNames.length) {
            let xpath = pattern;
            varNames.forEach(varName => {
                xpath = xpath.replace(new RegExp(`\\{${varName}\\}`, 'g'), currentValues[varName]);
            });
            combinations.push(xpath);
            return false;
        }

        const varName = varNames[index];
        const values = variables[varName];
        for (const value of values) {
            currentValues[varName] = value;
            generateCombos(index + 1, currentValues);
        }
    };

    generateCombos(0, {});
    return combinations;
}

/**
 * Generate add-image button XPaths with all possible combinations
 * Pattern: /html/body/div[1]/div[1]/div[A]/div/div/div[B]/div[1]/div/button
 * Generates all combinations of A and B values
 */
function getAddImageButtonXPaths() {
    const pattern = '/html/body/div[1]/div[1]/div[{A}]/div/div/div[{B}]/div[1]/div/button';
    const variants = {
        'A': [4, 5],      // div[4] or div[5]
        'B': [2, 3]       // div[2] or div[3]
    };
    return [
        PER_PROMPT_IMAGE_UPLOAD_XPATH,
        ...generateXPathVariants(pattern, variants)
    ];
}

const GEMINI_PLUS_BUTTON_XPATH = '/html/body/chat-app/main/side-navigation-v2/mat-sidenav-container/mat-sidenav-content/div/div[2]/chat-window/div/input-container/fieldset/input-area-v2/div/div/div[2]/div/uploader/div/div/button';
const GEMINI_UPLOAD_MENU_BUTTON_XPATH = '/html/body/div[8]/div/div/mat-card/mat-action-list/images-files-uploader/button';

async function openGeminiUploadMenuSafely() {
    const isMenuVisible = () => {
        const uploadMenuButton = getElementByXPath(GEMINI_UPLOAD_MENU_BUTTON_XPATH);
        return Boolean(uploadMenuButton && isElementVisible(uploadMenuButton));
    };

    if (isMenuVisible()) return true;

    const maxOpenAttempts = 4;
    for (let openAttempt = 0; openAttempt < maxOpenAttempts; openAttempt++) {
        const plusButton = getElementByXPath(GEMINI_PLUS_BUTTON_XPATH);
        if (!plusButton || !isElementVisible(plusButton) || plusButton.disabled || plusButton.getAttribute('aria-disabled') === 'true') {
            await new Promise(r => setTimeout(r, 200));
            continue;
        }
        forceUserLikeClick(plusButton);

        // Poll for menu visibility instead of fixed short delay.
        for (let waitAttempt = 0; waitAttempt < 12; waitAttempt++) {
            if (isMenuVisible()) return true;
            await new Promise(r => setTimeout(r, 120));
        }
    }

    return false;
}

function queryAllElementsDeep(selector, root = document) {
    const results = [];
    const visited = new Set();

    const walk = (node) => {
        if (!node || visited.has(node)) return;
        visited.add(node);

        try {
            if (typeof node.querySelectorAll === 'function') {
                const found = node.querySelectorAll(selector);
                found.forEach(el => results.push(el));

                const allChildren = node.querySelectorAll('*');
                allChildren.forEach(el => {
                    if (el && el.shadowRoot) {
                        walk(el.shadowRoot);
                    }
                });
            }
        } catch (e) { }
    };

    walk(root);
    return results;
}

async function activatePromptComposer() {
    const composerXPath = '/html/body/div[1]/div[1]/div[5]/div/div/div[1]/div';
    const composer = getElementByXPath(composerXPath);
    if (!composer || !isElementVisible(composer)) {
        console.info('-> Composer container not found via primary XPath, searching editor directly.');
        return false;
    }

    forceUserLikeClick(composer);
    await new Promise(r => setTimeout(r, 220));
    return composer;
}

function getEditorText(editor) {
    if (!editor) return '';
    if (editor.tagName === 'TEXTAREA' || editor.tagName === 'INPUT') {
        return (editor.value || '').trim();
    }
    return (editor.textContent || '').trim();
}

function getPromptEditorFromRoot(root) {
    if (!root) return null;
    const candidates = Array.from(root.querySelectorAll('textarea, input[type="text"], [contenteditable="true"], [role="textbox"]'))
        .filter(el => isElementVisible(el) && !el.disabled && !el.readOnly);
    if (candidates.length === 0) return null;

    const nonSearch = candidates.find(el => !(el.getAttribute('placeholder') || '').toLowerCase().includes('search'));
    return nonSearch || candidates[0];
}

function isElementVisible(element) {
    if (!element) return false;
    const rect = element.getBoundingClientRect();
    const style = window.getComputedStyle(element);
    return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
}

function forceUserLikeClick(element) {
    if (!element) return false;

    try {
        element.scrollIntoView({ behavior: 'smooth', block: 'center' });
    } catch (e) { }

    try {
        element.click();
    } catch (e) { }

    const pointerEvents = ['pointerover', 'pointerenter', 'pointerdown', 'pointerup'];
    pointerEvents.forEach((eventType) => {
        try {
            element.dispatchEvent(new PointerEvent(eventType, {
                bubbles: true,
                cancelable: true,
                pointerType: 'mouse',
                isPrimary: true,
                buttons: 1,
                view: window
            }));
        } catch (e) { }
    });

    const mouseEvents = ['mouseover', 'mouseenter', 'mousedown', 'mouseup', 'click'];
    mouseEvents.forEach((eventType) => {
        try {
            element.dispatchEvent(new MouseEvent(eventType, {
                bubbles: true,
                cancelable: true,
                buttons: 1,
                view: window
            }));
        } catch (e) { }
    });

    return true;
}

function clickElementOnce(element) {
    if (!element || !isElementVisible(element)) return false;
    if (element.disabled || element.getAttribute('aria-disabled') === 'true') return false;

    try {
        element.scrollIntoView({ behavior: 'smooth', block: 'center' });
    } catch (e) { }

    try {
        HTMLElement.prototype.click.call(element);
        return true;
    } catch (e) {
        try {
            element.click();
            return true;
        } catch (innerError) {
            return false;
        }
    }
}
function clickSubmitButtonSafely(button, mode) {
    if (!button || !isElementVisible(button)) return false;
    if (button.disabled || button.getAttribute('aria-disabled') === 'true') return false;

    const now = Date.now();
    const key = button;
    const lockMap = clickSubmitButtonSafely._lockMap || (clickSubmitButtonSafely._lockMap = new WeakMap());
    const lastAt = lockMap.get(key) || 0;

    // Prevent duplicate rapid clicks on submit button.
    if (now - lastAt < 1200) {
        return false;
    }
    lockMap.set(key, now);

    try {
        button.scrollIntoView({ behavior: 'smooth', block: 'center' });
    } catch (e) { }

    try {
        button.focus();
    } catch (e) { }

    const arrowIcon = button.querySelector('i.google-symbols, i.material-icons, .google-symbols, .material-icons');

    // IMAGE MODE: Use stronger event sequence for React compatibility
    if (isImageMode(mode)) {
        let clicked = false;
        try {
            clicked = !!forceUserLikeClick(button) || clicked;
        } catch (e) { }

        const iconTarget = arrowIcon;
        if (iconTarget) {
            try {
                clicked = !!forceUserLikeClick(iconTarget) || clicked;
            } catch (e) { }
        }

        try {
            const r = button.getBoundingClientRect();
            const cx = Math.round(r.left + r.width / 2);
            const cy = Math.round(r.top + r.height / 2);

            button.dispatchEvent(new PointerEvent('pointerdown', {
                bubbles: true,
                cancelable: true,
                pointerType: 'mouse',
                isPrimary: true,
                buttons: 1,
                button: 0,
                clientX: cx,
                clientY: cy,
                view: window
            }));
            button.dispatchEvent(new PointerEvent('pointerup', {
                bubbles: true,
                cancelable: true,
                pointerType: 'mouse',
                isPrimary: true,
                buttons: 0,
                button: 0,
                clientX: cx,
                clientY: cy,
                view: window
            }));
            button.dispatchEvent(new MouseEvent('mousedown', {
                bubbles: true,
                cancelable: true,
                buttons: 1,
                button: 0,
                clientX: cx,
                clientY: cy,
                view: window
            }));
            button.dispatchEvent(new MouseEvent('mouseup', {
                bubbles: true,
                cancelable: true,
                buttons: 0,
                button: 0,
                clientX: cx,
                clientY: cy,
                view: window
            }));
            button.dispatchEvent(new MouseEvent('click', {
                bubbles: true,
                cancelable: true,
                buttons: 0,
                button: 0,
                clientX: cx,
                clientY: cy,
                view: window
            }));
            clicked = true;
        } catch (e) { }

        try {
            button.click();
            clicked = true;
        } catch (e) { }

        try {
            button.dispatchEvent(new MouseEvent('mouseup', {
                bubbles: true,
                cancelable: true,
                buttons: 0,
                view: window
            }));
            button.dispatchEvent(new MouseEvent('click', {
                bubbles: true,
                cancelable: true,
                buttons: 0,
                view: window
            }));
            clicked = true;
        } catch (e) { }

        return clicked;
    }

    // VIDEO/TEXT MODE: Use the same user-like click path as the current UI button.
    try {
        if (forceUserLikeClick(button)) return true;
    } catch (e) { }

    if (arrowIcon && normalizeUiText(arrowIcon.textContent || '') === 'arrow_forward') {
        try {
            if (forceUserLikeClick(arrowIcon)) return true;
        } catch (e) { }
    }

    try {
        button.click();
        return true;
    } catch (e) {
        try {
            button.dispatchEvent(new MouseEvent('click', {
                bubbles: true,
                cancelable: true,
                view: window,
                buttons: 1
            }));
            return true;
        } catch (err) {
            return false;
        }
    }
}

function getPrimarySubmitButton() {
    const arrowForwardButton = findArrowForwardRunButton();
    if (arrowForwardButton) return arrowForwardButton;

    const bottomRightButton = findBottomRightRunButton();
    if (bottomRightButton) return bottomRightButton;

    const geometryButton = findRunButtonWithoutDebugger();
    if (geometryButton) return geometryButton;

    const buttons = Array.from(document.querySelectorAll('button, [role="button"]')).filter(isElementVisible);

    // 1. Find arrow_forward button
    const arrowBtn = buttons.find(btn => {
        const icon = btn.querySelector('.google-symbols');
        return icon && icon.textContent.trim() === 'arrow_forward';
    });
    if (arrowBtn) return arrowBtn;

    // 2. Find Generate / Run button
    const generateBtn = buttons.find(btn => {
        const text = btn.textContent.trim().toLowerCase();
        return text === 'generate' || text === 'run' || text === 'create';
    });

    return generateBtn || null;
}

function isClickableEnabled(element) {
    if (!element || !isElementVisible(element)) return false;
    if (element.disabled) return false;
    if ((element.getAttribute('aria-disabled') || '').toLowerCase() === 'true') return false;
    if ((element.getAttribute('disabled') || '').toLowerCase() === 'true') return false;
    return true;
}

function hasArrowForwardIcon(element) {
    if (!element) return false;
    return Array.from(element.querySelectorAll('i, .google-symbols, .material-icons'))
        .some(icon => String(icon.textContent || '').trim() === 'arrow_forward');
}

function getFlowPromptShell(editor = null) {
    if (!editor) return null;

    const classShell = editor.closest('div[class*="sc-26b30722-0"]');
    if (classShell && isElementVisible(classShell)) return classShell;

    let node = editor;
    for (let depth = 0; depth < 8 && node; depth++) {
        const hasEditor = !!node.querySelector?.('[data-slate-editor="true"], [role="textbox"], [contenteditable="true"]');
        const hasMode = Array.from(node.querySelectorAll?.('button, [role="button"]') || [])
            .some(btn => /video|image|\d+s|1x|2x|3x|4x/i.test(btn.textContent || ''));
        const hasRun = hasArrowForwardIcon(node);
        if (hasEditor && hasMode && hasRun) return node;
        node = node.parentElement;
    }

    return null;
}

function getFlowComposerContainer(editor = null) {
    const promptShell = getFlowPromptShell(editor);
    if (promptShell) return promptShell;

    if (editor) {
        let node = editor;
        for (let depth = 0; depth < 10 && node; depth++) {
            const buttons = Array.from(node.querySelectorAll('button, [role="button"]')).filter(isElementVisible);
            const rect = node.getBoundingClientRect();
            const hasTextbox = !!node.querySelector?.('[data-slate-editor="true"], [role="textbox"], [contenteditable="true"]');
            if (hasTextbox && buttons.length >= 3 && rect.bottom > window.innerHeight * 0.55 && rect.width > 300) {
                return node;
            }
            node = node.parentElement;
        }
    }

    const xpathCandidates = [
        '/html/body/div[1]/div[1]/div[5]/div/div/div/div',
        '/html/body/div[1]/div[1]/div[5]/div/div/div',
        '/html/body/div[1]/div[1]/div[5]'
    ];

    for (const xpath of xpathCandidates) {
        const el = getElementByXPath(xpath);
        if (el && isElementVisible(el)) return el;
    }

    if (editor) {
        let node = editor;
        for (let depth = 0; depth < 8 && node; depth++) {
            const buttons = Array.from(node.querySelectorAll('button, [role="button"]')).filter(isElementVisible);
            const rect = node.getBoundingClientRect();
            if (buttons.length >= 2 && rect.bottom > window.innerHeight * 0.55) {
                return node;
            }
            node = node.parentElement;
        }
    }

    const bottomPanels = Array.from(document.querySelectorAll('div, form'))
        .filter(isElementVisible)
        .map(el => ({ el, rect: el.getBoundingClientRect() }))
        .filter(item => {
            const { rect } = item;
            if (rect.width < 260 || rect.height < 44) return false;
            if (rect.bottom < window.innerHeight * 0.55) return false;
            const buttons = item.el.querySelectorAll('button, [role="button"]');
            return buttons.length >= 2;
        })
        .sort((a, b) => {
            const areaA = a.rect.width * a.rect.height;
            const areaB = b.rect.width * b.rect.height;
            return areaA - areaB;
        });

    return bottomPanels[0]?.el || null;
}

function getClosestClickableFromPoint(x, y) {
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
    if (x < 0 || y < 0 || x > window.innerWidth || y > window.innerHeight) return null;

    let el = null;
    try {
        el = document.elementFromPoint(x, y);
    } catch (e) {
        return null;
    }

    while (el && el !== document.body) {
        if (el.matches?.('button, [role="button"]') && isElementVisible(el)) {
            return el;
        }
        el = el.parentElement;
    }

    return null;
}

function isNonRunComposerButton(button) {
    if (!button) return true;

    const text = normalizeUiText(button.textContent || '');
    const icon = normalizeUiText(Array.from(button.querySelectorAll('i, .google-symbols, .material-icons'))
        .map(el => el.textContent || '')
        .join(' '));
    const aria = normalizeUiText(button.getAttribute('aria-label') || '');
    const haystack = `${text} ${icon} ${aria}`;

    if (haystack.includes('add_2')) return true;
    if (haystack.includes('close')) return true;
    if (haystack.includes('delete') || haystack.includes('xoa')) return true;
    if (haystack.includes('tac nhan') || haystack.includes('agent')) return true;
    if (haystack.includes('video') && /\d+s/.test(haystack)) return true;
    if (haystack.includes('image') || haystack.includes('hinh anh')) return true;
    if (/\b[1-4]x\b/.test(haystack) && /\d+s/.test(haystack)) return true;

    return false;
}

function findBottomRightRunButton(editor = null) {
    const composer = getFlowComposerContainer(editor);
    if (!composer || !isElementVisible(composer)) return null;

    const composerRect = composer.getBoundingClientRect();
    const buttons = Array.from(composer.querySelectorAll('button, [role="button"]'))
        .filter(isClickableEnabled)
        .map(button => ({ button, rect: button.getBoundingClientRect() }))
        .filter(item => {
            const { rect, button } = item;
            if (rect.width < 26 || rect.height < 26) return false;
            if (rect.bottom < composerRect.top + composerRect.height * 0.45) return false;
            if (rect.right < composerRect.left + composerRect.width * 0.55) return false;
            if (isNonRunComposerButton(button)) return false;
            return true;
        })
        .sort((a, b) => {
            const rightDiff = b.rect.right - a.rect.right;
            if (Math.abs(rightDiff) > 8) return rightDiff;
            return b.rect.bottom - a.rect.bottom;
        });

    if (buttons[0]?.button) {
        const rect = buttons[0].rect;
        console.log(`[run-detect] Found bottom-right run button at ${Math.round(rect.left)},${Math.round(rect.top)} ${Math.round(rect.width)}x${Math.round(rect.height)}.`);
        return buttons[0].button;
    }

    return null;
}

function isRunLikeButton(button) {
    if (!isClickableEnabled(button)) return false;

    const text = normalizeUiText(button.textContent || '');
    const aria = normalizeUiText(button.getAttribute('aria-label') || '');
    const title = normalizeUiText(button.getAttribute('title') || '');
    const icon = normalizeUiText(Array.from(button.querySelectorAll('i, .google-symbols, .material-icons, [class*="icon" i]'))
        .map(el => el.textContent || '')
        .join(' '));
    const haystack = `${text} ${aria} ${title} ${icon}`;

    return haystack.includes('arrow_forward')
        || haystack.includes('send')
        || haystack.includes('submit')
        || haystack.includes('generate')
        || haystack.includes('create')
        || haystack.includes('run')
        || haystack.includes('gui')
        || haystack.includes('tao');
}

function findArrowForwardRunButton(editor = null) {
    const promptShell = getFlowPromptShell(editor);
    if (promptShell) {
        const shellButtons = Array.from(promptShell.querySelectorAll('button, [role="button"]'))
            .filter(isClickableEnabled)
            .filter(hasArrowForwardIcon)
            .map(button => ({ button, rect: button.getBoundingClientRect() }))
            .sort((a, b) => {
                const rightDiff = b.rect.right - a.rect.right;
                if (Math.abs(rightDiff) > 8) return rightDiff;
                return b.rect.bottom - a.rect.bottom;
            });

        if (shellButtons[0]?.button) {
            console.log('[run-detect] Found arrow_forward run button inside prompt shell.');
            return shellButtons[0].button;
        }
    }

    const composer = getFlowComposerContainer(editor);
    const roots = [];
    if (composer) roots.push(composer);
    if (editor) {
        let node = editor;
        for (let depth = 0; depth < 8 && node; depth++) {
            roots.push(node);
            node = node.parentElement;
        }
    }
    roots.push(document);

    const seen = new Set();
    const candidates = [];

    for (const root of roots) {
        if (!root || seen.has(root)) continue;
        seen.add(root);

        const icons = Array.from(root.querySelectorAll('i.google-symbols, i.material-icons, .google-symbols, .material-icons'))
            .filter(icon => normalizeUiText(icon.textContent || '') === 'arrow_forward');

        for (const icon of icons) {
            const button = icon.closest('button, [role="button"]');
            if (!isClickableEnabled(button)) continue;

            const rect = button.getBoundingClientRect();
            if (rect.width < 18 || rect.height < 18) continue;

            const label = normalizeUiText(button.textContent || '');
            const score = [
                composer && composer.contains(button) ? 1000 : 0,
                editor && button.closest?.('form, section, main, div')?.contains?.(editor) ? 300 : 0,
                label.includes('tao') || label.includes('gui') || label.includes('create') || label.includes('send') ? 200 : 0,
                rect.bottom > window.innerHeight * 0.55 ? 100 : 0,
                Math.round(rect.right)
            ].reduce((sum, value) => sum + value, 0);

            candidates.push({ button, score, rect });
        }
    }

    candidates.sort((a, b) => {
        if (b.score !== a.score) return b.score - a.score;
        if (Math.abs(b.rect.bottom - a.rect.bottom) > 8) return b.rect.bottom - a.rect.bottom;
        return b.rect.right - a.rect.right;
    });

    return candidates[0]?.button || null;
}

function findRunButtonWithoutDebugger(editor = null) {
    const arrowForwardButton = findArrowForwardRunButton(editor);
    if (arrowForwardButton) return arrowForwardButton;

    const bottomRightButton = findBottomRightRunButton(editor);
    if (bottomRightButton) return bottomRightButton;

    const composer = getFlowComposerContainer(editor);
    const modeButton = getElementByXPath(MODE_TRIGGER_XPATH);

    if (modeButton && isElementVisible(modeButton)) {
        const modeRect = modeButton.getBoundingClientRect();
        const sameRowButtons = Array.from(document.querySelectorAll('button, [role="button"]'))
            .filter(isElementVisible)
            .filter(btn => btn !== modeButton)
            .map(btn => ({ btn, rect: btn.getBoundingClientRect() }))
            .filter(item => {
                const midY = item.rect.top + item.rect.height / 2;
                return item.rect.left >= modeRect.left
                    && item.rect.left > modeRect.right - 8
                    && Math.abs(midY - (modeRect.top + modeRect.height / 2)) <= Math.max(24, modeRect.height * 0.75);
            })
            .sort((a, b) => a.rect.left - b.rect.left);

        if (sameRowButtons[0]?.btn) return sameRowButtons[0].btn;

        const pointButton = getClosestClickableFromPoint(
            Math.round(modeRect.right + Math.max(30, modeRect.width * 0.45)),
            Math.round(modeRect.top + modeRect.height / 2)
        );
        if (pointButton && pointButton !== modeButton) return pointButton;
    }

    if (composer && isElementVisible(composer)) {
        const rect = composer.getBoundingClientRect();
        const probePoints = [
            [rect.right - 28, rect.bottom - 24],
            [rect.right - 42, rect.bottom - 24],
            [rect.right - 28, rect.top + rect.height / 2],
            [rect.right - 54, rect.top + rect.height / 2]
        ];

        for (const [x, y] of probePoints) {
            const btn = getClosestClickableFromPoint(Math.round(x), Math.round(y));
            if (btn && isRunLikeButton(btn)) return btn;
        }

        const buttons = Array.from(composer.querySelectorAll('button, [role="button"]'))
            .filter(isElementVisible)
            .map(btn => ({ btn, rect: btn.getBoundingClientRect() }))
            .filter(item => item.rect.width > 16 && item.rect.height > 16)
            .sort((a, b) => b.rect.left - a.rect.left);

        const runLike = buttons.find(item => isRunLikeButton(item.btn));
        if (runLike) return runLike.btn;

        if (buttons[0]?.btn) return buttons[0].btn;
    }

    const allButtons = Array.from(document.querySelectorAll('button, [role="button"]'))
        .filter(isElementVisible)
        .map(btn => ({ btn, rect: btn.getBoundingClientRect() }))
        .filter(item => item.rect.bottom > window.innerHeight * 0.55)
        .sort((a, b) => {
            const rightDiff = b.rect.right - a.rect.right;
            if (Math.abs(rightDiff) > 12) return rightDiff;
            return b.rect.bottom - a.rect.bottom;
        });

    return allButtons.find(item => isRunLikeButton(item.btn))?.btn || null;
}

function getBottomComposerEditor() {
    const editors = Array.from(document.querySelectorAll(
        '[data-slate-editor="true"], [contenteditable="true"], [role="textbox"], textarea, input[type="text"], input:not([type])'
    ))
        .filter(el => isElementVisible(el) && !el.disabled && !el.readOnly)
        .filter(el => {
            const placeholder = (el.getAttribute('placeholder') || '').toLowerCase();
            if (!placeholder) return true;
            return !placeholder.includes('search');
        });

    if (editors.length === 0) return null;
    return editors.sort((a, b) => b.getBoundingClientRect().top - a.getBoundingClientRect().top)[0];
}

function getBestPromptEditor() {
    const allEditors = Array.from(document.querySelectorAll(
        '[data-slate-editor="true"], [contenteditable="true"], [role="textbox"], textarea, input[type="text"], input:not([type])'
    ))
        .filter(el => isElementVisible(el) && !el.disabled && !el.readOnly)
        .filter(el => {
            const placeholder = (el.getAttribute('placeholder') || '').toLowerCase();
            return !placeholder.includes('search for assets') && !placeholder.includes('search assets');
        });

    if (allEditors.length === 0) return null;

    const preferred = allEditors.find(el => {
        const placeholder = (el.getAttribute('placeholder') || '').toLowerCase();
        const aria = (el.getAttribute('aria-label') || '').toLowerCase();
        return placeholder.includes('what do you want to create')
            || placeholder.includes('you want to create')
            || aria.includes('what do you want to create')
            || aria.includes('prompt');
    });

    if (preferred) return preferred;
    return allEditors.sort((a, b) => b.getBoundingClientRect().top - a.getBoundingClientRect().top)[0];
}

function setNativeInputValue(inputEl, value) {
    if (!inputEl) return;

    const prototype = Object.getPrototypeOf(inputEl);
    const descriptor = prototype ? Object.getOwnPropertyDescriptor(prototype, 'value') : null;
    if (descriptor && typeof descriptor.set === 'function') {
        descriptor.set.call(inputEl, value);
    } else {
        inputEl.value = value;
    }
}

function tryPasteIntoContentEditable(editor, promptText) {
    if (!editor) return false;

    try {
        editor.focus();
        editor.click();
    } catch (e) { }

    let pasteDispatched = false;
    try {
        const dataTransfer = new DataTransfer();
        dataTransfer.setData('text/plain', String(promptText || ''));
        pasteDispatched = editor.dispatchEvent(new ClipboardEvent('paste', {
            clipboardData: dataTransfer,
            bubbles: true,
            cancelable: true
        }));
    } catch (e) { }

    // Dispatch beforeinput/input events for editors with strict clipboard handling.
    try {
        editor.dispatchEvent(new InputEvent('beforeinput', {
            bubbles: true,
            cancelable: true,
            inputType: 'insertFromPaste',
            data: String(promptText || '')
        }));
    } catch (e) { }

    try {
        editor.dispatchEvent(new InputEvent('input', {
            bubbles: true,
            cancelable: true,
            inputType: 'insertFromPaste',
            data: String(promptText || '')
        }));
    } catch (e) {
        try {
            editor.dispatchEvent(new Event('input', { bubbles: true }));
        } catch (err) { }
    }

    try {
        editor.dispatchEvent(new Event('change', { bubbles: true }));
    } catch (e) { }

    return pasteDispatched;
}

function isImageMode(mode) {
    const safeMode = (mode || '').toLowerCase();
    return safeMode.includes('text-to-image') || safeMode.includes('ingredients-to-image');
}

function isPromptCommitted(editor, promptText) {
    if (!editor) return false;
    const current = getEditorText(editor).toLowerCase().trim();
    const target = (promptText || '').toLowerCase().trim();
    if (!target) return false;

    if (current.includes('you want to create')) {
        return false;
    }

    if (target.length <= 24) {
        return current.includes(target);
    }

    const headProbe = target.substring(0, 24);
    const tailProbe = target.substring(Math.max(0, target.length - 24));
    return current.includes(headProbe) && current.includes(tailProbe);
}

function getVisiblePromptRequiredErrorCount() {
    const keywords = [
        'prompt must be provided',
        'prompt is required',
        'please enter a prompt',
        'enter prompt'
    ];

    const candidates = Array.from(document.querySelectorAll('div, span, p, [role="alert"], [aria-live]'));
    let count = 0;

    for (const el of candidates) {
        if (!isElementVisible(el)) continue;
        const text = normalizeUiText(el.textContent || '');
        if (!text) continue;
        if (keywords.some(keyword => text.includes(normalizeUiText(keyword)))) {
            count += 1;
        }
    }

    return count;
}

async function waitForSubmitAcceptance(editor, promptText, beforeErrorCount, beforeGridSnapshot, timeoutMs = 3200, failureIdsBeforeSubmit = null, options = {}) {
    const startedAt = Date.now();
    let lastLogAt = 0;
    const assumeQueuedOnTimeout = !!options.assumeQueuedOnTimeout;

    while (Date.now() - startedAt < timeoutMs) {
        if (getVisibleFlowFailureCards(failureIdsBeforeSubmit).length > 0) {
            return { accepted: false, promptRequiredError: false, flowFailure: true, reason: 'flow-failure' };
        }

        const submitReady = await isSubmitButtonReadyForNextPrompt(editor);
        const activePercent = getActiveRenderPercent();

        const gridNow = getRenderGridSnapshot();
        const gridChanged = !!beforeGridSnapshot
            && (gridNow.count !== beforeGridSnapshot.count || gridNow.signature !== beforeGridSnapshot.signature);

        const promptStillCommitted = isPromptCommitted(editor, promptText);
        const afterErrorCount = getVisiblePromptRequiredErrorCount();
        const promptRequiredError = afterErrorCount > beforeErrorCount;

        const now = Date.now();
        if (now - lastLogAt > 500) {
            lastLogAt = now;
            const debugState = {
                submitReady,
                activePercent,
                gridChanged,
                promptStillCommitted,
                beforeErrorCount,
                afterErrorCount
            };
            console.log("[submit-acceptance] state=", JSON.stringify(debugState));
        }

        if (promptRequiredError) {
            return { accepted: false, promptRequiredError: true, reason: 'prompt-required' };
        }

        if (!submitReady) {
            return { accepted: true, promptRequiredError: false, reason: 'submit-locked' };
        }

        if (activePercent !== null) {
            return { accepted: true, promptRequiredError: false, reason: 'progress-visible' };
        }

        if (gridChanged) {
            return { accepted: true, promptRequiredError: false, reason: 'grid-changed' };
        }

        // UI clears prompt from editor after successful submission.
        if (!promptStillCommitted) {
            return { accepted: true, promptRequiredError: false, reason: 'editor-cleared' };
        }

        await new Promise(r => setTimeout(r, 180));
    }

    const finalErrorCount = getVisiblePromptRequiredErrorCount();
    console.log("[submit-acceptance] timeout=", JSON.stringify({
        finalErrorCount,
        beforeErrorCount,
        promptRequiredError: finalErrorCount > beforeErrorCount
    }));
    const promptRequiredError = finalErrorCount > beforeErrorCount;
    return {
        accepted: assumeQueuedOnTimeout && !promptRequiredError,
        promptRequiredError,
        reason: promptRequiredError ? 'prompt-required' : (assumeQueuedOnTimeout ? 'timeout-assume-queued' : 'timeout-no-strong-signal')
    };
}

function getSubmitButtonNearEditor(editor, mode) {
    const arrowForwardButton = findArrowForwardRunButton(editor);
    if (arrowForwardButton && isElementVisible(arrowForwardButton)) {
        return arrowForwardButton;
    }

    const bottomRightButton = findBottomRightRunButton(editor);
    if (bottomRightButton && isElementVisible(bottomRightButton)) {
        return bottomRightButton;
    }

    const geometryRunButton = findRunButtonWithoutDebugger(editor);
    if (geometryRunButton && isElementVisible(geometryRunButton)) {
        return geometryRunButton;
    }

    const currentRunButton = getElementByXPath(RUN_BUTTON_XPATH);
    if (currentRunButton && isElementVisible(currentRunButton)) {
        return currentRunButton;
    }

    // IMAGE MODE: Prefer icon + span label match to avoid brittle XPath
    if (isImageMode(mode)) {
        const imageButtons = Array.from(document.querySelectorAll('button, [role="button"]'))
            .filter(el => isElementVisible(el));

        const imageSubmitCandidate = imageButtons.find(btn => {
            const icon = btn.querySelector('i.google-symbols');
            if (!icon || (icon.textContent || '').trim() !== 'arrow_forward') return false;
            const labelSpan = btn.querySelector('span');
            if (!labelSpan) return false;
            const rawLabel = (labelSpan.textContent || '').trim().toLowerCase();
            const normalizedLabel = rawLabel.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
            return normalizedLabel === 'tao';
        });

        if (imageSubmitCandidate) {
            return imageSubmitCandidate;
        }

        const imageIconOnly = imageButtons.find(btn => {
            const icon = btn.querySelector('i.google-symbols');
            return icon && (icon.textContent || '').trim() === 'arrow_forward';
        });

        if (imageIconOnly) {
            return imageIconOnly;
        }

        const imageSubmitBtn = getElementByXPath(RUN_BUTTON_XPATH);
        if (imageSubmitBtn && isElementVisible(imageSubmitBtn)) {
            return imageSubmitBtn;
        }
    }

    if (editor) {
        let parent = editor;
        for (let depth = 0; depth < 8 && parent; depth++) {
            const localArrow = Array.from(parent.querySelectorAll('button, div[role="button"]')).find(btn => {
                if (!isElementVisible(btn)) return false;
                const icon = btn.querySelector('i.google-symbols');
                return icon && icon.textContent.trim() === 'arrow_forward';
            });
            if (localArrow) return localArrow;
            parent = parent.parentElement;
        }
    }

    const allButtons = Array.from(document.querySelectorAll('button, div[role="button"]'))
        .filter(el => isElementVisible(el));

    const arrowButtons = allButtons.filter(btn => {
        const icon = btn.querySelector('i.google-symbols');
        return icon && icon.textContent.trim() === 'arrow_forward';
    });

    if (arrowButtons.length === 0) {
        return getPrimarySubmitButton();
    }

    if (!editor) {
        return arrowButtons.sort((a, b) => b.getBoundingClientRect().top - a.getBoundingClientRect().top)[0];
    }

    const er = editor.getBoundingClientRect();
    const ex = er.left + er.width / 2;
    const ey = er.top + er.height / 2;

    const ranked = arrowButtons
        .map(btn => {
            const br = btn.getBoundingClientRect();
            const bx = br.left + br.width / 2;
            const by = br.top + br.height / 2;
            const distance = Math.hypot(bx - ex, by - ey);
            return { btn, distance, by };
        })
        .sort((a, b) => a.distance - b.distance);

    return ranked.sort((a, b) => b.by - a.by)[0]?.btn || getPrimarySubmitButton();
}

function insertPromptIntoEditor(editor, promptText) {
    if (!editor) return false;

    const isNativeInput = editor.tagName === 'TEXTAREA'
        || (editor.tagName === 'INPUT' && ((editor.getAttribute('type') || 'text').toLowerCase() === 'text'));

    // Check prompt size - warn if > 8KB
    const promptSizeKB = (new TextEncoder().encode(promptText).length) / 1024;
    if (promptSizeKB > 8) {
        console.warn(`⚠️ Large prompt size: ${promptSizeKB.toFixed(1)}KB`);
    }

    if (isNativeInput) {
        editor.focus();
        editor.click();
        setNativeInputValue(editor, '');
        editor.dispatchEvent(new Event('input', { bubbles: true }));

        setNativeInputValue(editor, promptText);
        editor.dispatchEvent(new Event('input', { bubbles: true }));
        editor.dispatchEvent(new Event('change', { bubbles: true }));
        return isPromptCommitted(editor, promptText);
    }

    // Avoid direct Slate/React DOM mutation to prevent client exceptions.
    tryPasteIntoContentEditable(editor, promptText);
    return isPromptCommitted(editor, promptText);
}

function hardSetPromptIntoEditor(editor, promptText) {
    if (!editor) return false;

    const isNativeInput = editor.tagName === 'TEXTAREA'
        || editor.tagName === 'INPUT';

    // Check for large data size
    try {
        const promptSizeKB = (new TextEncoder().encode(promptText).length) / 1024;
        if (promptSizeKB > 8) {
            console.warn(`⚠️ hardSetPromptIntoEditor - Prompt size: ${promptSizeKB.toFixed(1)}KB`);
            // Wait longer on large inputs to avoid UI frame drop
            if (promptSizeKB > 15) {
      console.warn(`⚠️ Very large prompt (${promptSizeKB.toFixed(1)}KB)`);
            }
        }
    } catch (e) { }

    if (isNativeInput) {
        editor.focus();
        setNativeInputValue(editor, promptText);
        editor.dispatchEvent(new Event('input', { bubbles: true }));
        editor.dispatchEvent(new Event('change', { bubbles: true }));
        return isPromptCommitted(editor, promptText);
    }

    // Use event-based paste for Slate contenteditable to avoid DOM mismatch.
    tryPasteIntoContentEditable(editor, promptText);

    return isPromptCommitted(editor, promptText);
}

function findSubmitButton(editorElement) {
    const root = editorElement ? (editorElement.closest('form, section, main, [role="region"], [class*="panel" i], [class*="composer" i]') || document) : document;

    const strictSelectors = [
        'button[type="submit"]',
        'button[aria-label*="Send" i]',
        'button[aria-label*="Generate" i]',
        'div[role="button"][aria-label*="Send" i]',
        'div[role="button"][aria-label*="Generate" i]'
    ];

    for (const selector of strictSelectors) {
        const element = root.querySelector(selector) || document.querySelector(selector);
        if (element && isElementVisible(element) && !element.disabled && element.getAttribute('aria-disabled') !== 'true') {
            return element;
        }
    }

    const textTokens = ['send', 'generate', 'create', 'run'];
    const candidates = Array.from(root.querySelectorAll('button, [role="button"], div[tabindex]'));

    for (const candidate of candidates) {
        if (!isElementVisible(candidate)) continue;
        if (candidate.disabled || candidate.getAttribute('aria-disabled') === 'true') continue;

        const text = (candidate.textContent || '').trim().toLowerCase();
        if (textTokens.some(token => text.includes(token))) {
            return candidate;
        }
    }

    const legacy = getElementByXPath('/html/body/div[1]/div[1]/div[5]/div/div/div[3]/div[2]');
    return (legacy && isElementVisible(legacy)) ? legacy : null;
}

// Image attachment helper
async function handleAutoUploadIngredients(promptText, uploadedFiles, groupId, index) {
    console.log("-> Auto-attaching image matching prompt:", promptText);
    return autoAttachFrameImage(promptText, uploadedFiles, groupId, index, 'ingredients-to-video');
}

// Auto open menu and select output count via XPath
async function selectOutputQuantity(count) {
    console.log(`Setting Output count to x${count}...`);

    const normalizedCount = Number.isFinite(+count) ? Math.max(1, Math.min(4, parseInt(count, 10))) : 1;
    const targetText = `x${normalizedCount}`;
    const videoOutputXPath = `/html/body/div[3]/div/div[4]/div/button[${normalizedCount}]`;

    const videoOutputButton = getElementByXPath(videoOutputXPath);
    if (videoOutputButton && isElementVisible(videoOutputButton)) {
        forceUserLikeClick(videoOutputButton);
        await new Promise(r => setTimeout(r, 300));
        console.log(`-> Da chon Outputs per Prompt theo XPath video: ${targetText}`);
        return true;
    }

    const outputTriggerXPaths = [
        MODE_TRIGGER_XPATH,
        '/html/body/div[1]/div[1]/div[5]/div/div/div[3]/div[2]/button[1]',
        '/html/body/div[1]/div[1]/div[5]/div/div/div[2]/div[2]/button[1]'
    ];

    const getVisibleOutputTabLists = () => {
        const visibleTabLists = Array.from(document.querySelectorAll('[role="tablist"]'))
            .filter(el => isElementVisible(el));

        return visibleTabLists.filter(tabList => {
            const tabs = Array.from(tabList.querySelectorAll('button[role="tab"], [role="tab"]'))
                .filter(tab => isElementVisible(tab));
            if (tabs.length < 2) return false;
            const xTabs = tabs.filter(tab => /^x\d+$/i.test((tab.textContent || '').trim()));
            return xTabs.length >= 2;
        });
    };

    const clickOutputTabIfAvailable = async () => {
        const outputTabLists = getVisibleOutputTabLists();
        if (outputTabLists.length === 0) return false;

        const activeTabList = outputTabLists[outputTabLists.length - 1];
        const outputTabs = Array.from(activeTabList.querySelectorAll('button[role="tab"], [role="tab"]'))
            .filter(tab => isElementVisible(tab));

        const targetTab = outputTabs.find(tab => (tab.textContent || '').trim().toLowerCase() === targetText.toLowerCase());
        if (!targetTab) return false;

        for (let attempt = 0; attempt < 2; attempt++) {
            forceUserLikeClick(targetTab);
            await new Promise(r => setTimeout(r, 220));

            const selected = targetTab.getAttribute('aria-selected') === 'true'
                || (targetTab.getAttribute('data-state') || '').toLowerCase() === 'active';
            if (selected) {
                console.log(`-> Output selected via tab: [${targetText}]`);
                return true;
            }
        }

        console.warn(`-> Clicked tab [${targetText}], active state pending.`);
        return false;
    };

    // Attempt 1: select directly if output cluster is already open.
    if (await clickOutputTabIfAvailable()) {
        return true;
    }

    // Attempt 2: force open panel.
    const openedOutputPanel = await forceClickAnyXPath(outputTriggerXPaths, 650);
    if (openedOutputPanel) {
        await new Promise(r => setTimeout(r, 450));
        const openedVideoOutputButton = getElementByXPath(videoOutputXPath);
        if (openedVideoOutputButton && isElementVisible(openedVideoOutputButton)) {
            forceUserLikeClick(openedVideoOutputButton);
            await new Promise(r => setTimeout(r, 300));
            console.log(`-> Da chon Outputs per Prompt sau khi mo panel: ${targetText}`);
            return true;
        }
        if (await clickOutputTabIfAvailable()) {
            return true;
        }
    }

    const directButtons = Array.from(document.querySelectorAll('button, [role="button"]'))
        .filter(el => isElementVisible(el) && !el.disabled && el.getAttribute('aria-disabled') !== 'true');

    const directTarget = directButtons.find(el => (el.textContent || '').trim() === targetText);
    if (directTarget) {
        forceUserLikeClick(directTarget);
        console.log(`-> Output directly selected: [${targetText}]`);
        return true;
    }

    let btnOpenMenu = getElementByXPath(outputTriggerXPaths[0]) || getElementByXPath(outputTriggerXPaths[1]);

    if (!btnOpenMenu) {
        const candidateTrigger = directButtons.find(el => {
            const text = (el.textContent || '').trim().toLowerCase();
            return /^x\d+$/.test(text) || text.includes('output') || text.includes('quantity') || text.includes('video x');
        });
        if (candidateTrigger) btnOpenMenu = candidateTrigger;
    }

    if (btnOpenMenu) {
        await new Promise(r => setTimeout(r, 500));
        btnOpenMenu.scrollIntoView({ behavior: 'smooth', block: 'center' });
        await new Promise(r => setTimeout(r, 200));

        btnOpenMenu.focus();
        forceUserLikeClick(btnOpenMenu);

        await new Promise(r => setTimeout(r, 600));

        const tabs = Array.from(document.querySelectorAll('button[role="tab"], [role="menuitem"], button, [role="button"]'))
            .filter(el => isElementVisible(el));
        const btnSelect = tabs.find(tab => (tab.textContent || '').trim().toLowerCase() === targetText.toLowerCase());

        if (btnSelect) {
            btnSelect.scrollIntoView({ behavior: 'smooth', block: 'center' });
            await new Promise(r => setTimeout(r, 100));

            forceUserLikeClick(btnSelect);
    console.log(`-> Step 2: Output [${targetText}] selected!`);
            document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
            return true;
        } else {
            console.info(`-> Option [${targetText}] not found in menu, keeping default output.`);
            return true;
        }
    } else {
        console.info("-> Output control not detected on current interface, proceeding with defaults.");
        return true;
    }
}

// ==========================================
// FORCE REACT INPUT & ENABLE SUBMIT
// ==========================================
// ==========================================
// FORCE REACT & SLATE.JS INPUT DISPATCH
// ==========================================
// ==========================================
// DISPATCH PASTE EVENT TO SLATE.JS
// ==========================================
// ==========================================
// FORCE REACT & SLATE.JS INPUT DISPATCH
// ==========================================
// ==========================================
// DISPATCH SLATE DATA-SLATE-STRING
// ==========================================
// ==========================================
// DISPATCH SYNTHETIC EVENTS (NO DOM MUTATION)
// ==========================================
// ==========================================
// CLEAN CONSOLE SLATE INPUT HANDLER
// ==========================================
// ==========================================
// SLATE INPUT HANDLER ACROSS IMAGE/VIDEO MODES
// ==========================================
async function fillPromptToWeb(promptText, mode) {
    const safeMode = (mode || '').toLowerCase();
    const preserveComponentImages = safeMode.includes('frame-to-video')
        || safeMode.includes('frame to video')
        || safeMode.includes('ingredients-to-video')
        || safeMode.includes('ingredients to video')
        || safeMode.includes('ingredients-to-image')
        || safeMode.includes('ingredients to image');

    // Escape when image preservation not needed
    if (!preserveComponentImages) {
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        await new Promise(r => setTimeout(r, 120));
    }

    // In ingredients mode, wait for React re-render
    const waitTime = preserveComponentImages ? 1800 : 1000;
    console.log(`-> Waiting ${waitTime}ms for editor readiness...`);
    await new Promise(r => setTimeout(r, waitTime));

    // Retry up to 15 times
    let editor = null;
    for (let attempt = 0; attempt < 15; attempt++) {
        await activatePromptComposer();
        editor = getBestPromptEditor() || getBottomComposerEditor();
        if (editor) {
    // Verify editor interactable
            const rect = editor.getBoundingClientRect();
            if (rect.width > 0 && rect.height > 0) break;
        }
    await new Promise(r => setTimeout(r, 300));
    }

    if (!editor) {
        console.error("-> ❌ Editor input field not found!");
        return null;
    }

    // Step 2: Cleanup when not preserving
    if (!preserveComponentImages) {
        const allIcons = Array.from(document.querySelectorAll('i.google-symbols')).reverse();
        for (let icon of allIcons) {
            if (icon.textContent.trim() === 'close' && icon.closest('button')) {
                icon.closest('button').click();
                await new Promise(r => setTimeout(r, 400));
                editor = getBestPromptEditor() || getBottomComposerEditor() || editor;
                break;
            }
        }
    }

    if (!editor) return null;

    // Focus composer before typing
    await activatePromptComposer();
    await new Promise(r => setTimeout(r, 200));

    // 3. Wake up editor
    editor.scrollIntoView({ behavior: 'smooth', block: 'center' });
    editor.focus();
    editor.click();
    await new Promise(r => setTimeout(r, 300));

    // 4. Input prompt
    let committed = false;
    try {
        committed = insertPromptIntoEditor(editor, promptText);
    } catch (e) {
        console.error('[fillPromptToWeb] insertPromptIntoEditor error:', e.message);
        committed = false;
    }

    await new Promise(r => setTimeout(r, 180));

    // 5. Fallback paste
    if (!committed) {
        try {
            const dataTransfer = new DataTransfer();
            dataTransfer.setData('text/plain', promptText);
            editor.dispatchEvent(new ClipboardEvent('paste', {
                clipboardData: dataTransfer,
                bubbles: true,
                cancelable: true
            }));
        } catch (e) {
            console.warn('[fillPromptToWeb] Paste fallback triggered:', e.message);
        }
        await new Promise(r => setTimeout(r, 220));
        committed = isPromptCommitted(editor, promptText);
    }

    if (!committed) {
        try {
            committed = hardSetPromptIntoEditor(editor, promptText);
        } catch (e) {
            console.error('[fillPromptToWeb] hardSet error:', e.message);
            committed = false;
        }
        await new Promise(r => setTimeout(r, 180));
    }

    // 6. Ghost text check
    let currentText = getEditorText(editor).toLowerCase();
    if (!committed || currentText.includes("you want to create") || currentText.includes("create") || !currentText.includes(promptText.substring(0, 3).toLowerCase())) {
        console.log("-> ⚠️ Ghost text detected, re-applying prompt...");
        try {
            committed = insertPromptIntoEditor(editor, promptText);
        } catch (e) { committed = false; }
        await new Promise(r => setTimeout(r, 220));
    }

    // 7. Synthetic space to activate submit button
    editor.focus();
    if (editor.tagName === 'TEXTAREA' || editor.tagName === 'INPUT') {
        const currentValue = editor.value || '';
        setNativeInputValue(editor, `${currentValue} `);
        editor.dispatchEvent(new Event('input', { bubbles: true }));
    } else {
        try {
            editor.dispatchEvent(new InputEvent('beforeinput', {
                bubbles: true, cancelable: true,
                inputType: 'insertText', data: ' '
            }));
        } catch (e) { }
        editor.dispatchEvent(new Event('input', { bubbles: true }));
    }

    await new Promise(r => setTimeout(r, 200));

    if (!isPromptCommitted(editor, promptText)) {
        const secondTry = hardSetPromptIntoEditor(editor, promptText);
        if (!secondTry) return null;
    }

    if (!isPromptCommitted(editor, promptText)) return null;

    return editor;
}
// ==========================================
// CREATE FLOATING PROGRESS BAR
// ==========================================
function createOrUpdateProgressBar(percent) {
    const container = document.getElementById('veo-auto-progress');
    if (container) {
        container.remove();
    }
}

async function isSubmitButtonReadyForNextPrompt(editorRef = null, selectedModeRef = '', groupIdRef = undefined, indexRef = undefined) {
    const editor = editorRef || getBestPromptEditor() || getBottomComposerEditor() || null;
    const selectedMode = String(selectedModeRef || '');
    let submitButton = getSubmitButtonNearEditor(editor, selectedMode) || findSubmitButton(editor) || getPrimarySubmitButton();

    // --- WAKE UP SUBMIT BUTTON IF DISABLED ---
    if (submitButton && (submitButton.disabled || submitButton.getAttribute('aria-disabled') === 'true')) {
        if (groupIdRef !== undefined && indexRef !== undefined) {
  safeSendQueueStatus({ groupId: groupIdRef, index: indexRef, status: 'Waking submit button... ⏳', percent: 0 });
        }
        try {
            if (editor) {
                editor.focus();
                const currentValue = getEditorText(editor);
                if (editor.tagName === 'TEXTAREA' || editor.tagName === 'INPUT') {
                    setNativeInputValue(editor, currentValue + ' ');
                    editor.dispatchEvent(new Event('input', { bubbles: true }));
                    editor.dispatchEvent(new Event('change', { bubbles: true }));
                }
            }
            await new Promise(r => setTimeout(r, 600));
            // Query submit button after wake up
            submitButton = getSubmitButtonNearEditor(editor, selectedMode) || findSubmitButton(editor) || getPrimarySubmitButton();
        } catch (e) { }
    }

    if (!submitButton || submitButton.disabled || submitButton.getAttribute('aria-disabled') === 'true') {
        if (groupIdRef !== undefined && indexRef !== undefined) {
            safeSendQueueStatus({ groupId: groupIdRef, index: indexRef, status: 'Submit button not found or locked ❌', percent: 0 });
        }
        return false;
    }
    if (!isElementVisible(submitButton)) return false;
    if (submitButton.disabled) return false;
    if (submitButton.getAttribute('aria-disabled') === 'true') return false;
    return true;
}

function getActiveRenderPercent() {
    const progressXPaths = [
        "/html/body/div[1]/div[1]/div[1]/div[2]/div/div/div[2]/div[1]/div/div[1]/div[3]/div/div[1]/div",
        "/html/body/div[1]/div[1]/div[1]/div[2]/div/div/div[2]/div[1]/div/div[1]/div[2]/div/div[1]/div"
    ];
    const percentValues = [];

    for (const xpath of progressXPaths) {
        const progressEl = document.evaluate(xpath, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue;
        if (!progressEl) continue;

        const text = (progressEl.textContent || '').trim();
        const match = text.match(/(\d+)%/);
        if (match) {
            const val = parseInt(match[1], 10);
            if (Number.isFinite(val)) percentValues.push(Math.max(0, Math.min(100, val)));
        }
    }

    if (percentValues.length > 0) {
        return (_currentOutputCount || 1) > 1
            ? Math.min(...percentValues)
            : Math.max(...percentValues);
    }

    const percentNodes = Array.from(document.querySelectorAll('div, span, p, strong'))
        .filter(el => isElementVisible(el) && el.children.length === 0)
        .map(el => (el.textContent || '').trim())
        .filter(text => /^\d{1,3}%$/.test(text))
        .map(text => parseInt(text.replace('%', ''), 10))
        .filter(v => Number.isFinite(v) && v >= 0 && v <= 100);

    if (percentNodes.length === 0) return null;
    if ((_currentOutputCount || 1) > 1) {
        return Math.min(...percentNodes);
    }
    return Math.max(...percentNodes);
}

function getRenderGridSnapshot() {
    const gridContainerXPaths = [
        "/html/body/div[1]/div[1]/div[4]/div[2]/div/div/div[2]/div[1]/div",
        "/html/body/div[1]/div[1]/div[4]/div[2]/div/div/div[2]/div[1]",
        "/html/body/div[1]/div[1]/div[4]/div[2]/div/div/div[2]"
    ];

    let container = null;
    for (const xpath of gridContainerXPaths) {
        const node = document.evaluate(xpath, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue;
        if (node && isElementVisible(node)) {
            container = node;
            break;
        }
    }

    if (!container) {
        return { count: 0, signature: '' };
    }

    const cards = Array.from(container.children).filter(el => isElementVisible(el));
    const signature = cards
        .slice(0, 8)
        .map(card => normalizeName((card.textContent || '').replace(/\s+/g, ' ').trim()).slice(0, 80))
        .join('|');

    return { count: cards.length, signature };
}

function clearRenderCardOwners() {
    const ownedCards = Array.from(document.querySelectorAll('[data-veo-owner]'));
    for (const card of ownedCards) {
        try {
            card.removeAttribute('data-veo-owner');
        } catch (e) { }
    }
}

async function waitForPromptCompletionOrReady(groupId, promptIndex, maxAttempts = 120) {
    let attempts = 0;
    let seenProgress = false;
    let startedRunning = false;
    let seenGridChange = false;
    let maxPercentSeen = 0;
    const startedAt = Date.now();
    const initialGrid = getRenderGridSnapshot();

    const extendBtnXPath = "/html/body/div[1]/div[1]/div[1]/div[2]/div/div/div[2]/div[2]/div/div[2]/div/button[1]";

    while (attempts < maxAttempts) {
        attempts++;

        const myPercentValue = getActiveRenderPercent();

        const submitReady = await isSubmitButtonReadyForNextPrompt(null, '', groupId, promptIndex);
        if (!submitReady) {
            startedRunning = true;
        }

        const gridNow = getRenderGridSnapshot();
        if (gridNow.count !== initialGrid.count || gridNow.signature !== initialGrid.signature) {
            seenGridChange = true;
            startedRunning = true;
        }

        if (myPercentValue !== null) {
            seenProgress = true;
            startedRunning = true;
            maxPercentSeen = Math.max(maxPercentSeen, myPercentValue);
            safeSendQueueStatus({ groupId, index: promptIndex, status: `Rendering: ${myPercentValue}% 🚀`, percent: myPercentValue });

            // Return only at 100%
            if (myPercentValue >= 100) {
                safeSendQueueStatus({ groupId, index: promptIndex, status: 'Xong ✅', percent: 100 });
                return true;
            }
        } else {
            if (seenProgress || startedRunning) {
                safeSendQueueStatus({ groupId, index: promptIndex, status: `Rendering... (${maxPercentSeen}%) ⏳`, percent: maxPercentSeen });
            } else {
    safeSendQueueStatus({ groupId, index: promptIndex, status: 'Preparing ⏳', percent: 0 });
            }

            // Mark done when render started and settled
            const elapsedMs = Date.now() - startedAt;
            if (seenProgress && seenGridChange && elapsedMs > 30000 && submitReady) {
                safeSendQueueStatus({ groupId, index: promptIndex, status: 'Xong ✅', percent: 100 });
                return true;
            }
        }

        await new Promise(r => setTimeout(r, 1500));
    }

    // Timeout fallback
    if (seenProgress && seenGridChange) {
    safeSendQueueStatus({ groupId, index: promptIndex, status: 'Timeout, marked done ⚠️', percent: 100 });
        return true;
    }

    return false;
}

// ==========================================
// PROGRESS MONITOR AND REPORTING TO POPUP
// ==========================================
// ==========================================
// PROMISE-BASED PROGRESS MONITORING
// ==========================================
function monitorVideoProgress(promptIndex, promptText, groupId = undefined, selectedMode = '', deferDownload = false, failureIdsBeforeSubmit = null) {
    return new Promise((resolve) => {
        const counterMap = monitorVideoProgress._groupCounters || (monitorVideoProgress._groupCounters = new Map());
        const sequenceMap = monitorVideoProgress._groupSequence || (monitorVideoProgress._groupSequence = new Map());
        const activeOrdersMap = monitorVideoProgress._activeOrders || (monitorVideoProgress._activeOrders = new Map());
        const groupKey = String(groupId || 'default-group');
        const ownerKey = `${groupKey}:${String(promptIndex)}`;
        const startOrder = (sequenceMap.get(groupKey) || 0) + 1;
        sequenceMap.set(groupKey, startOrder);
        counterMap.set(groupKey, (counterMap.get(groupKey) || 0) + 1);
        const activeOrders = activeOrdersMap.get(groupKey) || new Set();
        activeOrders.add(startOrder);
        activeOrdersMap.set(groupKey, activeOrders);

        let hasSeenPercent = false;
        let attempts = 0;
        let lockedCard = null;
        let missingPercentStreak = 0;
        let lastPercentSeen = 0;
        let lastPercentChangedAt = Date.now();
        let lockedCardIdentity = '';
        let finalized = false;
        let interval = null;
        const normalizedPrompt = String(promptText || '').toLowerCase();
        const searchSnippet = normalizedPrompt.trim().substring(0, 80);
        const strongPromptHints = [];
        const sceneMatch = normalizedPrompt.match(/"scene_number"\s*:\s*(\d+)/i);
        const sceneNumberHint = (sceneMatch && sceneMatch[1]) ? String(sceneMatch[1]) : '';
        if (sceneMatch && sceneMatch[1]) {
            strongPromptHints.push(`"scene_number": ${sceneMatch[1]}`);
            strongPromptHints.push(`"scene_number":${sceneMatch[1]}`);
        }
        const timecodeMatch = normalizedPrompt.match(/"timecode"\s*:\s*"([^"]+)"/i);
        const timecodeHint = (timecodeMatch && timecodeMatch[1]) ? String(timecodeMatch[1]).toLowerCase().trim() : '';
        if (timecodeMatch && timecodeMatch[1]) {
            const tc = String(timecodeMatch[1]).toLowerCase().trim();
            if (tc) {
                strongPromptHints.push(`"timecode": "${tc}"`);
                strongPromptHints.push(tc);
            }
        }
        const hasStrongHints = strongPromptHints.length > 0;
        const safeMode = String(selectedMode || '').toLowerCase();
        const isTextToVideoMode = safeMode.includes('text-to-video') || safeMode.includes('text to video');
        const gridContainerXPaths = [
            "/html/body/div[1]/div[1]/div[4]/div[2]/div/div/div[2]/div[1]/div",
            "/html/body/div[1]/div[1]/div[3]/div[1]/div/div/div[2]/div[6]",
            "/html/body/div[1]/div[1]/div[3]/div[1]/div/div/div[2]",
            "/html/body/div[1]/div[1]/div[4]/div[2]/div/div/div[2]/div[1]",
            "/html/body/div[1]/div[1]/div[4]/div[2]/div/div/div[2]"
        ];
        const extendBtnXPath = "/html/body/div[1]/div[1]/div[1]/div[2]/div/div/div[2]/div[2]/div/div[2]/div/button[1]";
        const normalizeTimecodeValue = (value) => String(value || '')
            .toLowerCase()
            .replace(/\s+/g, '')
            .replace(/[–—]/g, '-')
            .trim();
        const normalizedTimecodeHint = normalizeTimecodeValue(timecodeHint);
        const getRenderGridContainer = () => {
            for (const xpath of gridContainerXPaths) {
                const node = document.evaluate(xpath, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue;
                if (!node || !isElementVisible(node)) continue;
                const hasDirectCards = Array.from(node.children || []).some(child => isElementVisible(child));
                if (hasDirectCards) return node;
            }

            const marker = Array.from(document.querySelectorAll('div[data-index][data-item-index]'))
                .find(el => isElementVisible(el));
            if (!marker) return null;

            // Ascend to common ancestor to locate render grid container.
            let current = marker.parentElement;
            while (current && current !== document.body) {
                const visibleChildren = Array.from(current.children || []).filter(child => isElementVisible(child));
                const dataIndexChildren = visibleChildren.filter(child => child.hasAttribute('data-index') || child.hasAttribute('data-item-index'));
                if (dataIndexChildren.length >= 2) return current;
                current = current.parentElement;
            }

            return marker.parentElement || null;
        };

        const getGroupMonitorCount = () => counterMap.get(groupKey) || 0;
        const getExpectedDataIndex = () => {
            const set = activeOrdersMap.get(groupKey);
            if (!set || set.size === 0) return null;
            const sorted = Array.from(set).sort((a, b) => a - b);
            const rank = sorted.indexOf(startOrder) + 1; // oldest=1
            if (rank <= 0) return null;
            return sorted.length - rank + 1; // oldest -> highest data-index
        };
        const lockCardByDataIndex = () => {
            const expectedIdx = getExpectedDataIndex();
            if (expectedIdx === null) return null;

            const gridContainer = getRenderGridContainer();
            if (!gridContainer) return null;

            const cards = Array.from(gridContainer.children).filter(c => isElementVisible(c));
            return cards.find(card => {
                const raw = card.getAttribute('data-index') || card.getAttribute('data-item-index') || '';
                return parseInt(raw, 10) === expectedIdx;
            }) || null;
        };
        const finalize = (result) => {
            if (finalized) return;
            finalized = true;
            if (interval) clearInterval(interval);

    // Retain data-veo-owner attribute
            // Used by completion download to locate card
            // Cleared at end of batch
            lockedCard = null;
            lockedCardIdentity = '';

            const set = activeOrdersMap.get(groupKey);
            if (set) {
                set.delete(startOrder);
                if (set.size === 0) activeOrdersMap.delete(groupKey);
                else activeOrdersMap.set(groupKey, set);
            }

            const current = counterMap.get(groupKey) || 0;
            const next = current - 1;
            if (next > 0) counterMap.set(groupKey, next);
            else counterMap.delete(groupKey);

            resolve(result);
        };

        const readPercentFromCard = (card) => {
            if (!card || !isElementVisible(card)) return null;
            const allTexts = Array.from(card.querySelectorAll('*'));
            const percentEl = allTexts.find(el => {
                const text = (el.textContent || '').trim();
                return /\d{1,3}%/.test(text) && el.children.length === 0;
            });
            if (!percentEl) return null;
            const match = (percentEl.textContent || '').trim().match(/(\d{1,3})%/);
            if (!match) return null;
            const parsed = parseInt(match[1], 10);
            return Number.isFinite(parsed) ? parsed : null;
        };

        const getLowestVisiblePercentInGrid = (grid) => {
            if (!grid) return null;

            const values = Array.from(grid.children)
                .filter(card => isElementVisible(card))
                .map(card => readPercentFromCard(card))
                .filter(value => value !== null);

            if (values.length === 0) return null;
            return Math.min(...values);
        };

        const isCardLikelyCompleted = (card) => {
            if (!card || !isElementVisible(card)) return false;
            if (readPercentFromCard(card) !== null) return false;

            const hasMedia = !!card.querySelector('img, video, canvas');
            const hasAction = !!card.querySelector('button, [role="button"], a[href], i.google-symbols');
            const stillRunning = isFlowPendingText(card.textContent || '');

            return hasMedia && hasAction && !stillRunning;
        };

        const getCardIdentity = (card) => {
            if (!card) return '';
            const img = card.querySelector('img');
            const imgKey = (img?.currentSrc || img?.src || '').trim().slice(0, 160);
            const textKey = (card.textContent || '')
                .toLowerCase()
                .replace(/\d{1,3}%/g, '')
                .replace(/\s+/g, ' ')
                .trim()
                .slice(0, 220);
            return `${imgKey}||${textKey}`;
        };

        interval = setInterval(async () => {
            attempts++;
            if (attempts > 400) {
                safeSendMessage({ action: "UPDATE_QUEUE_STATUS", groupId, index: promptIndex, status: "Monitor timeout — no Flow error detected.", percent: lastPercentSeen || 0 });
                finalize(true);
                return;
            }

            const safeSendMessage = (msgPayload) => {
                try { chrome.runtime?.sendMessage(msgPayload).catch(() => { }); } catch (e) { }
            };

            const gridContainer = getRenderGridContainer();
            let myPercentValue = null;
            let foundCard = null;
            const visibleFailureCards = getVisibleFlowFailureCards(failureIdsBeforeSubmit);
            if (visibleFailureCards.length > 0) {
                const newestFailure = visibleFailureCards
                    .sort((a, b) => b.getBoundingClientRect().top - a.getBoundingClientRect().top)[0];
                try { newestFailure.setAttribute('data-veo-owner', ownerKey); } catch (e) { }
                markPromptRenderFailure(groupId, promptIndex);
                safeSendMessage({ action: "UPDATE_QUEUE_STATUS", groupId, index: promptIndex, status: "Flow reported error, will retry...", percent: 0 });
                finalize(false);
                return;
            }

            // ============================================================
            // STEP 1: SCAN GRID
            // Priority: scene hint -> data-index -> owned card -> any rendering card
            // ============================================================
            // ============================================================
            // STEP 1: LOCK CARD BY DATA-ITEM-INDEX WITH FALLBACK
            // ============================================================
            if (gridContainer) {
                const cards = Array.from(gridContainer.children).filter(c => isElementVisible(c));

                // 1a. Scene hint match
                if (!foundCard && sceneNumberHint) {
                    for (const card of cards) {
                        const txt = (card.textContent || '').toLowerCase();
                        if (txt.includes(`"scene_number": ${sceneNumberHint}`) || txt.includes(`"scene_number":${sceneNumberHint}`)) {
                            const pct = readPercentFromCard(card);
                            if (pct !== null) { myPercentValue = pct; foundCard = card; break; }
                        }
                    }
                }

                // 1b. Lock by data-item-index in concurrent mode
                if (!foundCard) {
                    const expectedIdx = getExpectedDataIndex();
                    if (expectedIdx !== null) {
                        const byIndex = cards.find(card => {
                            const raw = card.getAttribute('data-index') || card.getAttribute('data-item-index') || '';
                            return parseInt(raw, 10) === expectedIdx;
                        });
                        if (byIndex) {
                            // Use locked card by index
                            foundCard = byIndex;
                            myPercentValue = readPercentFromCard(byIndex);
                        }
                    }
                }

                // 1c. Remaining owner attribute
                if (!foundCard) {
                    const ownedCard = cards.find(c => c.getAttribute('data-veo-owner') === ownerKey);
                    if (ownedCard) { foundCard = ownedCard; myPercentValue = readPercentFromCard(ownedCard); }
                }

                // 1d. Fallback: card with matching %
                if (!foundCard) {
                    const minPct = hasSeenPercent ? Math.max(0, lastPercentSeen - 2) : 0;
                    const unowned = cards
                        .filter(card => {
                            const owner = card.getAttribute('data-veo-owner');
                            if (owner && owner !== ownerKey) return false;
                            const pct = readPercentFromCard(card);
                            return pct !== null && pct >= minPct;
                        })
                        .sort((a, b) => (readPercentFromCard(b) || 0) - (readPercentFromCard(a) || 0))[0];
                    if (unowned) { foundCard = unowned; myPercentValue = readPercentFromCard(unowned); }
                }

                // 1e. First unowned rendering card
                if (!foundCard && !hasSeenPercent) {
                    const anyRendering = cards.find(card => {
                        const owner = card.getAttribute('data-veo-owner');
                        if (owner && owner !== ownerKey) return false;
                        if (readPercentFromCard(card) !== null) return true;
                        return isFlowPendingText(card.textContent || '');
                    });
                    if (anyRendering) { foundCard = anyRendering; myPercentValue = readPercentFromCard(anyRendering); }
                }
            }

            // ============================================================
            // STEP 2: Update lockedCard and data-veo-owner
            // Re-apply on each tick
            // ============================================================
            if (foundCard) {
                // Clean legacy owner
                if (lockedCard && lockedCard !== foundCard && document.contains(lockedCard)) {
                    try { lockedCard.removeAttribute('data-veo-owner'); } catch (e) { }
                }
                // Re-apply attribute
                try { foundCard.setAttribute('data-veo-owner', ownerKey); } catch (e) { }
                lockedCard = foundCard;
                lockedCardIdentity = getCardIdentity(foundCard);
            } else if (lockedCard && document.contains(lockedCard)) {
                // Retain lockedCard if new card not found
                try { lockedCard.setAttribute('data-veo-owner', ownerKey); } catch (e) { }
                if (myPercentValue === null) {
                    myPercentValue = readPercentFromCard(lockedCard);
                }
            }

            if ((_currentOutputCount || 1) > 1) {
                const lowestGridPercent = getLowestVisiblePercentInGrid(gridContainer);
                if (lowestGridPercent !== null) {
                    myPercentValue = myPercentValue === null
                        ? lowestGridPercent
                        : Math.min(myPercentValue, lowestGridPercent);
                }
            }

            // ============================================================
            // STEP 3: Handle progress percentage
            // ============================================================
            if (myPercentValue !== null) {
                // Progress detected -> update status
                hasSeenPercent = true;
                missingPercentStreak = 0;
                if (myPercentValue > lastPercentSeen) {
                    lastPercentChangedAt = Date.now();
                }
                lastPercentSeen = Math.max(lastPercentSeen, myPercentValue);

                createOrUpdateProgressBar(myPercentValue);
                safeSendMessage({
                    action: "UPDATE_QUEUE_STATUS",
                    groupId, index: promptIndex,
                    status: `Rendering: ${myPercentValue}% 🚀`,
                    percent: myPercentValue
                });

                if (myPercentValue >= 100) {
                    safeSendMessage({ action: "UPDATE_QUEUE_STATUS", groupId, index: promptIndex, status: "Xong ✅", percent: 100 });
                    createOrUpdateProgressBar(100);
                    if (!deferDownload) {
                        // Trigger auto-download before finalizing (default behavior)
                        const downloadOk = await handlePromptCompletionDownload(promptIndex, groupId, selectedMode);
                        if (downloadOk === false) {
                            finalize(false);
                            return;
                        }
                    }
                    finalize(true);
                }

            } else if (hasSeenPercent) {
                // Check if rendering finished after seeing progress

                // Increment streak when no progress cards on grid
                const anyCardShowingPercent = !!(gridContainer && Array.from(gridContainer.children).some(card => {
                    if (!isElementVisible(card)) return false;
                    return readPercentFromCard(card) !== null;
                }));

                if (anyCardShowingPercent) {
                    missingPercentStreak = 0; // Video still actively rendering
                } else {
                    missingPercentStreak++;
                }

                const submitReady = await isSubmitButtonReadyForNextPrompt(null, selectedMode, groupId, promptIndex);
                const noProgressMs = Date.now() - lastPercentChangedAt;
                const isParallelMonitoring = getGroupMonitorCount() > 1;

                // Done signals
                const extendBtn = getElementByXPath("/html/body/div[1]/div[1]/div[1]/div[2]/div/div/div[2]/div[2]/div/div[2]/div/button[1]");
                const hasStrongDoneSignal = !!(!isParallelMonitoring && submitReady && extendBtn && isElementVisible(extendBtn) && !extendBtn.disabled);

                const hasCardDoneSignal = !!(lockedCard && isCardLikelyCompleted(lockedCard));

                const hasSafeTimeoutDone = !!(!isParallelMonitoring && submitReady && missingPercentStreak >= 8 && noProgressMs >= 15000);

                // Parallel completion check
                const hasParallelDone = !!(isParallelMonitoring && submitReady && !anyCardShowingPercent && missingPercentStreak >= 8 && noProgressMs >= 25000);

                // Hard timeout
                const hasHardTimeout = !!(missingPercentStreak >= 15 && noProgressMs >= 40000 && !anyCardShowingPercent);

                if (hasStrongDoneSignal || hasCardDoneSignal || hasSafeTimeoutDone || hasParallelDone || hasHardTimeout) {
                    safeSendMessage({ action: "UPDATE_QUEUE_STATUS", groupId, index: promptIndex, status: "Done ✅", percent: 100 });
                    createOrUpdateProgressBar(100);
                    if (!deferDownload) {
                        // Trigger auto-download before finalizing (default behavior)
                        const downloadOk = await handlePromptCompletionDownload(promptIndex, groupId, selectedMode);
                        if (downloadOk === false) {
                            finalize(false);
                            return;
                        }
                    }
                    finalize(true);
                } else {
                    safeSendMessage({
                        action: "UPDATE_QUEUE_STATUS",
                        groupId, index: promptIndex,
                        status: `Rendering... (${lastPercentSeen}%) ⏳`,
                        percent: lastPercentSeen
                    });
                }

            } else {
                // Not seen percent yet -> preparing or starting
                const elapsedSinceStart = Date.now() - lastPercentChangedAt;
                const submitReady = await isSubmitButtonReadyForNextPrompt(null, selectedMode, groupId, promptIndex);

                const hasNeverSeenTimeout = !!(elapsedSinceStart >= 45000 && submitReady);
                const hasHardTimeout = !!(elapsedSinceStart >= 90000);

                if (hasNeverSeenTimeout || hasHardTimeout) {
                    safeSendMessage({ action: "UPDATE_QUEUE_STATUS", groupId, index: promptIndex, status: "Done ✅", percent: 100 });
                    createOrUpdateProgressBar(100);
                    if (!deferDownload) {
                        // Trigger auto-download before finalizing (default behavior)
                        const downloadOk = await handlePromptCompletionDownload(promptIndex, groupId, selectedMode);
                        if (downloadOk === false) {
                            finalize(false);
                            return;
                        }
                    }
                    finalize(true);
                    return;
                }

                // Display appropriate status
                const activeCards = gridContainer ? Array.from(gridContainer.children).filter(card => {
                    if (!isElementVisible(card)) return false;
                    return isFlowPendingText(card.textContent || '');
                }) : [];

                if (activeCards.length > 0) {
                    const multiMonitor = getGroupMonitorCount() > 1;
                    safeSendMessage({
                        action: "UPDATE_QUEUE_STATUS",
                        groupId, index: promptIndex,
                        status: multiMonitor ? "Mapping render card... ⏳" : "Rendering... ⏳",
                        percent: 1
                    });
                } else if (submitReady && elapsedSinceStart >= 10000) {
                    // No pending cards + submit ready + waited 10s = done
                    safeSendMessage({ action: "UPDATE_QUEUE_STATUS", groupId, index: promptIndex, status: "Done ✅", percent: 100 });
                    createOrUpdateProgressBar(100);
                    if (!deferDownload) {
                        // Trigger auto-download before finalizing (default behavior)
                        const downloadOk = await handlePromptCompletionDownload(promptIndex, groupId, selectedMode);
                        if (downloadOk === false) {
                            finalize(false);
                            return;
                        }
                    }
                    finalize(true);
                } else {
                    safeSendMessage({ action: "UPDATE_QUEUE_STATUS", groupId, index: promptIndex, status: "Preparing... ⚙️" });
                }
            }

        }, 1500);
    });
}

monitorVideoProgress._groupCounters = new Map();
monitorVideoProgress._groupSequence = new Map();
monitorVideoProgress._activeOrders = new Map();

// ==========================================
// TRACK RENDERING PROGRESS IN POPUP
// ==========================================
function monitorPopupProgress(groupId, promptIndex) {
    return new Promise((resolve) => {
        let attempts = 0;
        // Progress XPath
        const progressXPath = "/html/body/div[1]/div[1]/div[1]/div[2]/div/div/div[2]/div[1]/div/div[1]/div[3]/div/div[1]/div";
        // Expand button XPath to check completion
        const extendBtnXPath = "/html/body/div[1]/div[1]/div[1]/div[2]/div/div/div[2]/div[2]/div/div[2]/div/button[1]";

        const interval = setInterval(() => {
            attempts++;
            if (attempts > 400) { clearInterval(interval); resolve(false); return; }

            const progressEl = document.evaluate(progressXPath, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue;
            let myPercentValue = null;

            if (progressEl) {
                const text = progressEl.textContent.trim();
                const match = text.match(/(\d+)%/); // Match percentage number
                if (match) {
                    myPercentValue = parseInt(match[1]);
                }
            }

            if (myPercentValue === null && hasSeenPercent && gridContainer) {
                const recoveryCard = Array.from(gridContainer.children).find(card => {
                    if (!isElementVisible(card)) return false;
                    if (card.getAttribute('data-veo-owner') !== ownerKey) return false;
                    return readPercentFromCard(card) !== null;
                });
                if (recoveryCard) {
                    myPercentValue = readPercentFromCard(recoveryCard);
                    lockedCard = recoveryCard;
                    lockedCardIdentity = getCardIdentity(recoveryCard);
                    missingPercentStreak = 0; // Reset streak, progress detected
                }
            }

            const safeSendMessage = (msgPayload) => {
                try { chrome.runtime?.sendMessage(msgPayload).catch(() => { }); } catch (e) { }
            };

            if (myPercentValue !== null) {
                createOrUpdateProgressBar(myPercentValue);
                safeSendMessage({ action: "UPDATE_QUEUE_STATUS", groupId: groupId, index: promptIndex, status: `Rendering: ${myPercentValue}% 🚀`, percent: myPercentValue });

                if (myPercentValue >= 100) {
                    safeSendMessage({ action: "UPDATE_QUEUE_STATUS", groupId: groupId, index: promptIndex, status: "Done ✅", percent: 100 });
                    createOrUpdateProgressBar(100);
                    clearInterval(interval);
                    resolve(true);
                }
            } else {
                // Check if extend button is visible again -> Render complete
                const extendBtn = document.evaluate(extendBtnXPath, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue;
                if (attempts > 10 && extendBtn && isElementVisible(extendBtn) && !extendBtn.disabled) {
                    safeSendMessage({ action: "UPDATE_QUEUE_STATUS", groupId: groupId, index: promptIndex, status: "Done ✅", percent: 100 });
                    createOrUpdateProgressBar(100);
                    clearInterval(interval);
                    resolve(true);
                } else {
                    safeSendMessage({ action: "UPDATE_QUEUE_STATUS", groupId: groupId, index: promptIndex, status: "Preparing... ⚙️", percent: 0 });
                }
            }
        }, 1500);
    });
}

// ==========================================
// SMART CLICK HELPER FOR REACT ASYNC HANDLERS
// =========================================

// ==========================================
// FIND AND CLICK BUTTON BY INNER TEXT
// ==========================================
// ==========================================
// DEEP BUTTON CLICKER (SCANS DIV/SPAN WRAPPERS)
// ==========================================
async function clickByText(keywords, waitTime = 600, searchInLastDivOnly = false) {
    if (!Array.isArray(keywords)) keywords = [keywords];

    let container = document;
    if (searchInLastDivOnly) {
        const divs = document.querySelectorAll('body > div');
        container = divs[divs.length - 1];
    }

    // Scan clickable candidates
    const elements = container.querySelectorAll('button, [role="button"], [role="tab"], [role="menuitem"], div, span');

    for (let el of elements) {
        // Evaluate elements with direct text
        if (el.children.length > 2) continue;

        const text = el.textContent.trim().toLowerCase();
        if (keywords.some(kw => text === kw.toLowerCase() || text.includes(kw.toLowerCase()))) {
            // Trigger mouseover for React listeners
            el.scrollIntoView({ block: 'center' });
            el.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));

            // Multi-phase click dispatch
            const events = ['mousedown', 'mouseup', 'click'];
            events.forEach(evt => {
                el.dispatchEvent(new MouseEvent(evt, { bubbles: true, cancelable: true, view: window }));
            });

            console.log(`-> Located and clicked button: "${text}"`);
            await new Promise(r => setTimeout(r, waitTime));
            return true;
        }
    }
    console.warn("-> ⏳ Button not found containing keywords:", keywords);
    return false;
}

// ==========================================
// CONFIGURE MODE AND MODEL (RUNS ONCE)
// ==========================================
// ==========================================
// ROBUST ELEMENT CLICK DISPATCHER
// ==========================================
const VIDEO_MODEL_OPTIONS = {
    "omni-flash": "Omni Flash",
    "veo-3.1-lite": "Veo 3.1 - Lite",
    "veo-3.1-fast": "Veo 3.1 - Fast",
    "veo-3.1-quality": "Veo 3.1 - Quality",
    "veo-3.1-lite-lower": "Veo 3.1 - Lite [Lower Priority]",
    "veo-3.1-fast-lower": "Veo 3.1 - Fast [Lower Priority]"
};

function getVideoModelOption(videoModel) {
    const normalizedVideoModel = (videoModel || "").toLowerCase();

    if (normalizedVideoModel.includes("omni")) return VIDEO_MODEL_OPTIONS["omni-flash"];
    if (normalizedVideoModel.includes("lite-lower")) return VIDEO_MODEL_OPTIONS["veo-3.1-lite-lower"];
    if (normalizedVideoModel.includes("fast-lower") || normalizedVideoModel.includes("lower")) return VIDEO_MODEL_OPTIONS["veo-3.1-fast-lower"];
    if (normalizedVideoModel.includes("quality")) return VIDEO_MODEL_OPTIONS["veo-3.1-quality"];
    if (normalizedVideoModel.includes("lite")) return VIDEO_MODEL_OPTIONS["veo-3.1-lite"];
    return VIDEO_MODEL_OPTIONS["veo-3.1-fast"];
}

async function clickVideoModelOption(videoModel, waitTime = 500) {
    const targetLabel = getVideoModelOption(videoModel);
    const labels = Object.values(VIDEO_MODEL_OPTIONS);
    const menuContainers = Array.from(document.querySelectorAll("body > div")).reverse();

    for (const container of menuContainers) {
        const text = container.textContent || "";
        if (!labels.some(label => text.includes(label))) continue;

        const buttons = Array.from(container.querySelectorAll('button, [role="button"], [role="menuitem"], div'));
        const target = buttons.find(el => (el.textContent || "").trim() === targetLabel);
        if (!target) continue;

        target.scrollIntoView({ behavior: "smooth", block: "center" });
        await new Promise(r => setTimeout(r, 100));
        forceUserLikeClick(target);
        await new Promise(r => setTimeout(r, waitTime));
        console.log(`-> Selected video model: ${targetLabel}`);
        return true;
    }

    console.warn(`-> Video model option not found by label: ${targetLabel}`);
    return false;
}

async function forceClickXPath(xpath, waitTime = 500) {
    const el = document.evaluate(xpath, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue;
    if (!el) {
        console.info("-> Element not found at XPath (skip):", xpath);
        return false;
    }

    // Scroll into center view
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    await new Promise(r => setTimeout(r, 100));

    // Dispatch full user interaction sequence
    forceUserLikeClick(el);
    await new Promise(r => setTimeout(r, 120));

    await new Promise(r => setTimeout(r, waitTime)); // Wait for UI transition
    return true;
}

async function forceClickAnyXPath(xpaths, waitTime = 500) {
    for (let idx = 0; idx < xpaths.length; idx++) {
        const xpath = xpaths[idx];
        const ok = await forceClickXPath(xpath, waitTime);
        if (ok) {
            console.log(`-> Clicked element via XPath: ${xpath}`);
            return true;
        }
    }
    console.log(`[forceClickAnyXPath] ✗ Failed to click any of ${xpaths.length} XPaths`);
    return false;
}

// ==========================================
// CONFIGURE 5 MODES VIA XPATH
// ==========================================
// ==========================================
// CONFIGURE 5 MODES (WITH IMAGE SUB-TABS)
// ==========================================
// ==========================================
// CONFIGURE 5 MODES (WITH IMAGE ORIENTATION)
// ==========================================
async function applyInitialSettings(mode, videoModel, imageModel, aspectRatio) {
    const modeTriggerXPaths = [
        MODE_TRIGGER_XPATH,
        "/html/body/div[1]/div[1]/div[5]/div/div/div[3]/div[2]/button[1]",
        "/html/body/div[1]/div[1]/div[5]/div/div/div[2]/div[2]/button[1]"
    ];
    const isMenuOpened = await forceClickAnyXPath(modeTriggerXPaths, 1000);

    if (!isMenuOpened) return true;

    const safeMode = (mode || "").toLowerCase();
    const isVertical = (aspectRatio || "").includes("9:16"); // Check aspect ratio orientation

    // ==========================================
    // BRANCH 1: IMAGE GENERATION
    // ==========================================
    if (safeMode.includes("image")) {
        console.log("-> Configuring Image Tab...");
        if (!await forceClickXPath("/html/body/div[3]/div/div[1]/div/button[1]", 800)) {
            await clickByText(["Image"], 800, true);
        }

        // SELECT ASPECT RATIO (5 OPTIONS)
        if (aspectRatio === "16:9") {
            console.log("-> Selecting 16:9 Aspect Ratio...");
            await forceClickXPath("/html/body/div[3]/div/div[2]/div/button[1]", 600);
        } else if (aspectRatio === "4:3") {
            console.log("-> Selecting 4:3 Aspect Ratio...");
            await forceClickXPath("/html/body/div[3]/div/div[2]/div/button[2]", 600);
        } else if (aspectRatio === "1:1") {
            console.log("-> Selecting 1:1 Aspect Ratio...");
            await forceClickXPath("/html/body/div[3]/div/div[2]/div/button[3]", 600);
        } else if (aspectRatio === "3:4") {
            console.log("-> Selecting 3:4 Aspect Ratio...");
            await forceClickXPath("/html/body/div[3]/div/div[2]/div/button[4]", 600);
        } else if (aspectRatio === "9:16") {
            console.log("-> Selecting 9:16 Aspect Ratio...");
            await forceClickXPath("/html/body/div[3]/div/div[2]/div/button[5]", 600);
        } else {
            console.log("-> Selecting default Aspect Ratio (16:9)...");
            await forceClickXPath("/html/body/div[3]/div/div[2]/div/button[1]", 600);
        }

        // Select Image Model
        if (await forceClickXPath("/html/body/div[3]/div/button", 600)) {
            if (imageModel.includes("pro")) await forceClickXPath("/html/body/div[4]/div/div[1]/div/button", 500);
            else if (imageModel.includes("imagen")) await forceClickXPath("/html/body/div[4]/div/div[3]/div/button", 500);
            else await forceClickXPath("/html/body/div[4]/div/div[2]/div/button", 500);
        }

        // ==========================================
        // BRANCH 2: VIDEO GENERATION
        // ==========================================
    } else {
        console.log("-> Configuring Video Tab...");
        if (!await forceClickXPath("/html/body/div[3]/div/div[1]/div/button[2]", 800)) {
            await clickByText(["Video"], 800, true);
        }

        if (safeMode.includes("frame")) {
            console.log("-> Selecting Frame Sub-tab (Video)...");
            await forceClickXPath("/html/body/div[3]/div/div[2]/div/button[1]", 600);
        } else {
            console.log("-> Selecting Ingredients Sub-tab (Video)...");
            await forceClickXPath("/html/body/div[3]/div/div[2]/div/button[2]", 600);
        }

        if (aspectRatio === "9:16") {
            console.log("-> Selecting video aspect ratio 9:16...");
            await forceClickXPath("/html/body/div[3]/div/div[3]/div/button[1]", 600);
        } else {
            console.log("-> Selecting video aspect ratio 16:9...");
            await forceClickXPath("/html/body/div[3]/div/div[3]/div/button[2]", 600);
        }

        if (await forceClickXPath("/html/body/div[3]/div/button", 600)) {
            const normalizedVideoModel = (videoModel || "").toLowerCase();
            const clickedByLabel = await clickVideoModelOption(normalizedVideoModel, 500);

            // Menu mapping:
            // 1: Veo 3.1 - Lite
            // 2: Veo 3.1 - Fast
            // 3: Veo 3.1 - Quality
            // 4: Veo 3.1 - Lite [Lower Priority]
            // 5: Veo 3.1 - Fast [Lower Priority]
            if (!clickedByLabel) {
                if (normalizedVideoModel.includes("omni")) {
                    await forceClickXPath("/html/body/div[4]/div/div[1]/div/button", 500);
                } else if (normalizedVideoModel.includes("lite-lower")) {
                    await forceClickXPath("/html/body/div[4]/div/div[5]/div/button", 500);
                } else if (normalizedVideoModel.includes("fast-lower") || normalizedVideoModel.includes("lower")) {
                    await forceClickXPath("/html/body/div[4]/div/div[6]/div/button", 500);
                } else if (normalizedVideoModel.includes("quality")) {
                    await forceClickXPath("/html/body/div[4]/div/div[4]/div/button", 500);
                } else if (normalizedVideoModel.includes("lite")) {
                    await forceClickXPath("/html/body/div[4]/div/div[2]/div/button", 500);
                } else {
                    // Default: Veo 3.1 - Fast
                    await forceClickXPath("/html/body/div[4]/div/div[3]/div/button", 500);
                }
            }
        }
    }

    // Close Menu
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await new Promise(r => setTimeout(r, 600));
    return true;
}

function safeSendQueueStatus(payload) {
    try {
        chrome.runtime?.sendMessage({ action: "UPDATE_QUEUE_STATUS", ...payload }).catch(() => { });
    } catch (e) { }
}

function getRandomDelayMs(minDelay, maxDelay) {
    const min = Number.isFinite(+minDelay) ? Math.max(0, +minDelay) : 20;
    const max = Number.isFinite(+maxDelay) ? Math.max(min, +maxDelay) : Math.max(min, 30);
    const randomSeconds = Math.floor(Math.random() * (max - min + 1)) + min;
    return randomSeconds * 1000;
}

function normalizeName(input) {
    return String(input || '')
        .toLowerCase()
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/\.[^/.]+$/, '')
        .replace(/[^a-z0-9]+/g, ' ')
        .trim();
}

function pickMatchedFileForPrompt(promptText, uploadedFiles) {
    if (!Array.isArray(uploadedFiles) || uploadedFiles.length === 0) return null;

    const promptKey = normalizeName(promptText);
    if (!promptKey) return null;

    let best = null;

    for (const file of uploadedFiles) {
        const fileName = file?.name || '';
        const fileKey = normalizeName(fileName);
        if (!fileKey) continue;

        const exact = promptKey === fileKey;
        const includes = promptKey.includes(fileKey) || fileKey.includes(promptKey);
        const tokenHit = promptKey.split(' ').some(token => token.length >= 2 && fileKey.includes(token));

        let score = 0;
        if (exact) score += 100;
        if (includes) score += 50;
        if (tokenHit) score += 20;

        if (!best || score > best.score) {
            best = { file, score };
        }
    }

    return best && best.score > 0 ? best.file : null;
}

function pickMatchedFilesForPrompt(promptText, uploadedFiles, maxCount = 10) {
    if (!Array.isArray(uploadedFiles) || uploadedFiles.length === 0) return [];

    const promptKey = normalizeName(promptText);
    const promptTokens = promptKey.split(' ').filter(token => token.length >= 2);

    const scored = uploadedFiles
        .map(file => {
            const fileName = file?.name || '';
            const fileKey = normalizeName(fileName);
            if (!fileKey) return null;

            const exact = promptKey && promptKey === fileKey;
            const includes = promptKey && (promptKey.includes(fileKey) || fileKey.includes(promptKey));
            const tokenHits = promptTokens.filter(token => fileKey.includes(token)).length;

            let score = 0;
            if (exact) score += 200;
            if (includes) score += 100;
            score += tokenHits * 30;

            return { file, score, fileKey };
        })
        .filter(Boolean)
        .sort((a, b) => b.score - a.score);

    let picked = scored.filter(item => item.score > 0);
    if (picked.length === 0 && scored.length > 0) {
        picked = scored.slice(0, 1);
    }

    const seen = new Set();
    const uniqueFiles = [];
    for (const item of picked) {
        const key = item.fileKey || normalizeName(item.file?.name || '');
        if (!key || seen.has(key)) continue;
        seen.add(key);
        uniqueFiles.push(item.file);
        if (uniqueFiles.length >= maxCount) break;
    }

    return uniqueFiles;
}

function pickExactFilesByNames(uploadedFiles, targetNames, maxCount = 10) {
    if (!Array.isArray(uploadedFiles) || uploadedFiles.length === 0) return [];
    if (!Array.isArray(targetNames) || targetNames.length === 0) return [];

    const normalizedTargets = targetNames
        .map(name => normalizeName(name))
        .filter(Boolean);

    if (normalizedTargets.length === 0) return [];

    const used = new Set();
    const picked = [];

    for (const targetKey of normalizedTargets) {
        const matched = uploadedFiles.find(file => {
            const fileKey = normalizeName(file?.name || '');
            if (!fileKey || used.has(fileKey)) return false;
            return fileKey === targetKey;
        });

        if (matched) {
            const fileKey = normalizeName(matched?.name || '');
            if (fileKey) used.add(fileKey);
            picked.push(matched);
            if (picked.length >= maxCount) break;
        }
    }

    return picked;
}

function setFileToInput(fileInput, file) {
    if (!fileInput || !file) return false;
    try {
        const transfer = new DataTransfer();
        transfer.items.add(file);
        fileInput.files = transfer.files;
        fileInput.dispatchEvent(new Event('input', { bubbles: true }));
        fileInput.dispatchEvent(new Event('change', { bubbles: true }));
        return fileInput.files && fileInput.files.length > 0;
    } catch (error) {
        return false;
    }
}

function setFilesToInput(fileInput, files) {
    if (!fileInput || !Array.isArray(files) || files.length === 0) return false;
    try {
        const transfer = new DataTransfer();
        files.forEach(file => {
            if (file instanceof File) transfer.items.add(file);
        });
        if (transfer.files.length === 0) return false;

        const filesSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'files')?.set;
        if (filesSetter) {
            filesSetter.call(fileInput, transfer.files);
        } else {
            fileInput.files = transfer.files;
        }

        fileInput.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
        fileInput.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
        return fileInput.files && fileInput.files.length > 0;
    } catch (error) {
        return false;
    }
}

function dataUrlToFile(dataUrl, fileName, mimeType) {
    if (!dataUrl || typeof dataUrl !== 'string' || !dataUrl.startsWith('data:')) return null;
    const commaIndex = dataUrl.indexOf(',');
    if (commaIndex === -1) return null;

    const header = dataUrl.substring(0, commaIndex);
    const base64Data = dataUrl.substring(commaIndex + 1);
    const match = header.match(/^data:([^;]+);base64$/i);
    const contentType = (match && match[1]) ? match[1] : (mimeType || 'application/octet-stream');

    try {
        const binary = atob(base64Data);
        const bytes = new Uint8Array(binary.length);
        for (let index = 0; index < binary.length; index++) {
            bytes[index] = binary.charCodeAt(index);
        }
        return new File([bytes], fileName || 'upload.png', { type: contentType });
    } catch (error) {
        return null;
    }
}

function normalizeIncomingFile(fileLike) {
    if (!fileLike) return null;
    if (fileLike instanceof File) return fileLike;

    if (fileLike.dataUrl && fileLike.name) {
        return dataUrlToFile(fileLike.dataUrl, fileLike.name, fileLike.type);
    }

    return null;
}

function normalizeIncomingFiles(uploadedFiles) {
    if (!Array.isArray(uploadedFiles)) return [];
    return uploadedFiles.map(file => normalizeIncomingFile(file)).filter(Boolean);
}

async function injectFileToNewestInput(file, attempts = 10) {
    for (let i = 0; i < attempts; i++) {
        const inputs = Array.from(document.querySelectorAll('input[type="file"]'));
        const imageInput = inputs.reverse().find(input => {
            const accept = (input.getAttribute('accept') || '').toLowerCase();
            return !accept || accept.includes('image') || accept.includes('png') || accept.includes('jpeg') || accept.includes('jpg') || accept.includes('webp');
        });

        if (imageInput && setFileToInput(imageInput, file)) {
            return true;
        }

        await new Promise(r => setTimeout(r, 250));
    }

    return false;
}

async function injectFilesToNewestInput(files, attempts = 12) {
    for (let attempt = 0; attempt < attempts; attempt++) {
        const inputs = Array.from(document.querySelectorAll('input[type="file"]'));
        const imageInput = inputs.reverse().find(input => {
            const accept = (input.getAttribute('accept') || '').toLowerCase();
            return !accept || accept.includes('image') || accept.includes('png') || accept.includes('jpeg') || accept.includes('jpg') || accept.includes('webp');
        });

        if (imageInput && setFilesToInput(imageInput, files)) {
            return true;
        }

        await new Promise(r => setTimeout(r, 250));
    }

    return false;
}

function hasFrameImagePreviewRendered() {
    const modalRoot = getElementByXPath('/html/body/div[1]/div[2]/div/div/div/div');
    if (!modalRoot) return false;

    const visibleImage = Array.from(modalRoot.querySelectorAll('img')).find(img => {
        const rect = img.getBoundingClientRect();
        return rect.width > 8 && rect.height > 8;
    });
    if (visibleImage) return true;

    const text = (modalRoot.textContent || '').toLowerCase();
    const stillEmpty = text.includes('click to upload') || text.includes('drag & drop');
    return !stillEmpty;
}

function getVisibleAssetModalRoot() {
    const looksLikeAssetModal = (element) => {
        if (!element || !isElementVisible(element)) return false;

        const text = normalizeUiText(element.textContent || '');
        const hasAssetText = text.includes('search for assets')
            || text.includes('search assets')
            || text.includes('recent')
            || text.includes('gan day')
            || text.includes('tim kiem');
        const hasSearchInput = Array.from(element.querySelectorAll('input, [role="searchbox"]'))
            .some(input => {
                const hint = normalizeUiText(
                    input.getAttribute('placeholder') || input.getAttribute('aria-label') || ''
                );
                return hint.includes('search') || hint.includes('tim kiem');
            });

        return hasAssetText || hasSearchInput;
    };

    const knownRoots = [
        getElementByXPath('/html/body/div[1]/div[2]/div/div/div/div'),
        getElementByXPath('/html/body/div[1]/div[3]/div/div/div/div')
    ].filter(looksLikeAssetModal);

    const modalCandidates = Array.from(document.querySelectorAll('body > div, [role="dialog"]'))
        .filter(looksLikeAssetModal);

    if (knownRoots.length > 0) return knownRoots[knownRoots.length - 1];
    if (modalCandidates.length === 0) return null;
    return modalCandidates[modalCandidates.length - 1];
}
function isAssetModalVisible() {
    return !!getVisibleAssetModalRoot();
}

async function waitForAssetModalReady(maxAttempts = 20, intervalMs = 150) {
    for (let i = 0; i < maxAttempts; i++) {
        if (!isAssetModalVisible()) {
            await new Promise(r => setTimeout(r, intervalMs));
            continue;
        }

        // Check if dropdown button or recent assets list is visible
        const modalRoot = getVisibleAssetModalRoot();
        if (!modalRoot) {
            await new Promise(r => setTimeout(r, intervalMs));
            continue;
        }

        // Look for dropdown button or search field (signs of fully loaded modal)
        const dropdownBtn = Array.from(modalRoot.querySelectorAll('button, [role="button"]'))
            .find(btn => isElementVisible(btn) && !btn.disabled);

        if (dropdownBtn) {
            // Modal is ready with buttons visible
            console.log(`[waitForAssetModalReady] ✓ Asset modal fully rendered after ${i * intervalMs}ms`);
            return true;
        }

        await new Promise(r => setTimeout(r, intervalMs));
    }

    console.log(`[waitForAssetModalReady] ⚠️ Asset modal may not be fully ready`);
    return false;
}

async function waitForFrameImageReady(maxAttempts = 24, intervalMs = 250) {
    for (let i = 0; i < maxAttempts; i++) {
        if (hasFrameImagePreviewRendered()) {
            return true;
        }
        await new Promise(r => setTimeout(r, intervalMs));
    }
    return false;
}

async function waitForImageInputAvailable(maxAttempts = 20, intervalMs = 250) {
    for (let i = 0; i < maxAttempts; i++) {
        const inputs = Array.from(document.querySelectorAll('input[type="file"]'));
        const hasImageInput = inputs.some(input => {
            const accept = (input.getAttribute('accept') || '').toLowerCase();
            return !accept || accept.includes('image') || accept.includes('png') || accept.includes('jpeg') || accept.includes('jpg') || accept.includes('webp');
        });
        if (hasImageInput) return true;
        await new Promise(r => setTimeout(r, intervalMs));
    }
    return false;
}

function getRecentAssetCards() {
    const modalRoot = getVisibleAssetModalRoot() || document;
    const selectors = [
        'div[data-index][data-item-index]',
        '[role="option"]',
        'li',
        'button',
        'div'
    ];

    const fileNameRegex = /\.(png|jpe?g|webp|gif|bmp|avif)$/i;
    const allCandidates = selectors.flatMap(selector => Array.from(modalRoot.querySelectorAll(selector)));

    const uniqueCandidates = Array.from(new Set(allCandidates));
    return uniqueCandidates.filter(card => {
        if (!isElementVisible(card)) return false;
        const img = card.querySelector('img');
        if (!img) return false;

        const text = (card.textContent || '').trim();
        const alt = (img.getAttribute('alt') || '').trim();
        const nameText = alt || text;
        if (!nameText) return false;

        return fileNameRegex.test(nameText) || nameText.length <= 120;
    });
}

function getAssetNameFromCard(card) {
    if (!card) return '';
    const img = card.querySelector('img');
    const directText = (card.textContent || '').trim();
    const altText = (img?.getAttribute('alt') || '').trim();

    const fileNameRegex = /[\w\s-]+\.(png|jpe?g|webp|gif|bmp|avif)/i;
    const fromDirect = directText.match(fileNameRegex)?.[0] || '';
    const fromAlt = altText.match(fileNameRegex)?.[0] || '';

    return (fromDirect || fromAlt || altText || directText).trim();
}

function getAssetCardKey(card) {
    if (!card) return '';

    const nameKey = normalizeName(getAssetNameFromCard(card));
    if (nameKey) return `name:${nameKey}`;

    const img = card.querySelector('img');
    const src = (img?.currentSrc || img?.src || '').trim();
    if (src) {
        const srcName = src.split('/').pop()?.split('?')[0] || src;
        const srcKey = normalizeName(srcName) || src;
        return `src:${srcKey}`;
    }

    const dataIndex = card.getAttribute('data-index') || card.getAttribute('data-item-index') || '';
    if (dataIndex) return `index:${dataIndex}`;

    const rect = card.getBoundingClientRect();
    return `rect:${Math.round(rect.left)}:${Math.round(rect.top)}:${Math.round(rect.width)}:${Math.round(rect.height)}`;
}

function safeElementClick(element) {
    if (!element) return false;
    try {
        element.scrollIntoView({ behavior: 'smooth', block: 'center' });
    } catch (e) { }

    try {
        element.click();
    } catch (e) {
        try {
            element.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
        } catch (err) {
            return false;
        }
    }

    return true;
}

function clickRecentAssetCard(card) {
    if (!card) return false;

    const preferred = [
        card.querySelector('[role="button"][aria-roledescription="draggable"]'),
        card.querySelector('[role="button"][aria-describedby^="DndDescribedBy-"]'),
        card.querySelector('button[role="option"]'),
        card.querySelector('[role="option"]'),
        card.querySelector('button'),
        card.querySelector('[role="button"]'),
        card.querySelector('img')
    ].filter(Boolean);

    for (const node of preferred) {
        if (!isElementVisible(node)) continue;
        forceUserLikeClick(node);
        return true;
    }

    forceUserLikeClick(card);
    return true;
}

function getFrameSlotRegion(frameType) {
    const safeFrameType = String(frameType || '').toLowerCase();
    const regionKey = safeFrameType === 'last' ? 'END' : 'START';
    return document.querySelector(`[data-scroll-state="${regionKey}"]`);
}

function getFrameSlotAttachmentCount(frameType, anchorElement = null) {
    const scopeCandidates = [];

    // Priority 1: Use the region directly from data-scroll-state
    const region = getFrameSlotRegion(frameType);
    if (region) {
        scopeCandidates.push({ scope: region, label: 'scroll-state-region' });
        if (region.parentElement) scopeCandidates.push({ scope: region.parentElement, label: 'scroll-state-parent' });
    }

    // Priority 2: Use anchorElement's local scope
    if (anchorElement) {
        scopeCandidates.push({ scope: anchorElement, label: 'anchor-element' });
        if (anchorElement.parentElement) scopeCandidates.push({ scope: anchorElement.parentElement, label: 'anchor-parent' });
        if (anchorElement.parentElement?.parentElement) scopeCandidates.push({ scope: anchorElement.parentElement.parentElement, label: 'anchor-grandparent' });
    }

    if (scopeCandidates.length === 0) {
        const fallback = frameType === 'last' ? getAttachedMediaCount() : 0;
        return fallback;
    }

    // Scan each scope for attachment signals
    for (const { scope, label } of scopeCandidates) {
        if (!scope || !scope.querySelectorAll) continue;

        // Look for a remove/delete button or close icon (clear signal that something is attached)
        const removeButtons = Array.from(scope.querySelectorAll('button, [role="button"], i')).filter(node => {
            if (!isElementVisible(node)) return false;
            const aria = (node.getAttribute?.('aria-label') || '').toLowerCase();
            const icon = node.textContent?.trim?.().toLowerCase() || '';
            const iconAttr = node.getAttribute?.('data-icon') || '';
            return aria.includes('remove') || aria.includes('delete') || aria.includes('clear') ||
                icon === 'close' || icon === 'cancel' || icon === 'x' || icon === '×' ||
                iconAttr === 'close' || iconAttr === 'cancel';
        });

        if (removeButtons.length > 0) {
            console.log(`[getFrameSlotAttachmentCount] ${frameType} (${label}): found ${removeButtons.length} remove buttons`);
            return removeButtons.length;
        }

        // Also check for visible images as attachment indicator
        const images = Array.from(scope.querySelectorAll('img, video, canvas')).filter(node => {
            if (!isElementVisible(node)) return false;
            const rect = node.getBoundingClientRect();
            return rect.width > 8 && rect.height > 8; // Ignore tiny icons
        });

        if (images.length > 0) {
            console.log(`[getFrameSlotAttachmentCount] ${frameType} (${label}): found ${images.length} images`);
            return images.length;
        }
    }

    console.log(`[getFrameSlotAttachmentCount] ${frameType}: no attachment signals found in any scope`);
    return 0;
}

async function waitForFrameSlotAttachment(frameType, anchorElement = null, minExpectedCount = 1, maxAttempts = 24, intervalMs = 220) {
    for (let i = 0; i < maxAttempts; i++) {
        const currentCount = getFrameSlotAttachmentCount(frameType, anchorElement);
        if (currentCount >= minExpectedCount) {
            return true;
        }
        await new Promise(r => setTimeout(r, intervalMs));
    }
    return false;
}

async function clickAssetConfirmButton() {
    const modalRoot = getVisibleAssetModalRoot();
    if (!modalRoot) {
        // Close modal via Escape
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        await new Promise(r => setTimeout(r, 220));
        return true;
    }

    // Flow asset modal auto-applies on Escape
    // Close modal and apply selection
    modalRoot.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await new Promise(r => setTimeout(r, 320));

    return true;
}

function hasAnyAttachedMediaInComposer() {
    const composerRoots = [
        getElementByXPath('/html/body/div[1]/div[1]/div[5]/div/div/div[2]/div[1]'),
        getElementByXPath('/html/body/div[1]/div[1]/div[5]/div/div/div[3]/div[1]')
    ].filter(Boolean);

    if (composerRoots.length === 0) return false;

    return composerRoots.some(root => {
        const visualNodes = root.querySelectorAll('img, video, canvas, [data-media-id], [class*="chip" i], [class*="attachment" i], [class*="thumbnail" i]');
        return Array.from(visualNodes).some(node => isElementVisible(node));
    });
}

function getAttachedMediaCount() {
    const removeButtons = Array.from(document.querySelectorAll('button, [role="button"]')).filter(btn => {
        const aria = (btn.getAttribute('aria-label') || '').toLowerCase();
        const icon = btn.querySelector('.google-symbols');
        const iconText = icon ? icon.textContent.trim().toLowerCase() : '';
        return aria.includes('remove') || aria.includes('delete') || iconText === 'close' || iconText === 'cancel';
    });

    let count = 0;
    removeButtons.forEach(btn => {
        const rect = btn.getBoundingClientRect();
        // Handle close button visibility with scrollbars
        if (rect.top > window.innerHeight * 0.3) {
            count++;
        }
    });
    return count;
}

function clearAttachedMediaInComposer() {
    console.log("-> Clearing old media from composer...");
    // Scan for image attachment close buttons
    const removeButtons = Array.from(document.querySelectorAll('button, [role="button"]')).filter(btn => {
        if (!isElementVisible(btn)) return false;
        const aria = (btn.getAttribute('aria-label') || '').toLowerCase();
        const icon = btn.querySelector('.google-symbols');
        const iconText = icon ? icon.textContent.trim().toLowerCase() : '';
        return aria.includes('remove') || aria.includes('delete') || iconText === 'close' || iconText === 'cancel';
    });

    let clearedCount = 0;
    removeButtons.forEach(btn => {
        const rect = btn.getBoundingClientRect();
        // Target close buttons near composer
        if (rect.top > window.innerHeight * 0.4) {
            try {
                btn.click();
                clearedCount++;
            } catch (e) { }
        }
    });
    console.log(`-> Cleared ${clearedCount} media items.`);
}

function findAddImageButton() {
    const preferredButton = getElementByXPath(PER_PROMPT_IMAGE_UPLOAD_XPATH);
    if (preferredButton
        && isElementVisible(preferredButton)
        && !preferredButton.disabled
        && preferredButton.getAttribute('aria-disabled') !== 'true') {
        return preferredButton;
    }

    const candidates = Array.from(document.querySelectorAll('button, [role="button"], div[role="button"]'))
        .filter(el => isElementVisible(el) && !el.disabled && el.getAttribute('aria-disabled') !== 'true');

    const byLabel = candidates.filter(el => {
        const aria = (el.getAttribute('aria-label') || '').toLowerCase();
        const title = (el.getAttribute('title') || '').toLowerCase();
        const text = (el.textContent || '').trim().toLowerCase();
        return aria.includes('add')
            || aria.includes('upload')
            || aria.includes('image')
            || aria.includes('asset')
            || title.includes('add')
            || title.includes('upload')
            || title.includes('image')
            || text === '+';
    });

    if (byLabel.length > 0) {
        return byLabel.sort((a, b) => {
            const ar = a.getBoundingClientRect();
            const br = b.getBoundingClientRect();
            if (Math.abs(ar.top - br.top) > 6) return br.top - ar.top;
            return ar.left - br.left;
        })[0];
    }

    const byPlusIcon = candidates.filter(el => {
        const icon = el.querySelector('i.google-symbols');
        if (!icon) return false;
        const iconText = (icon.textContent || '').trim().toLowerCase();
        return iconText === 'add' || iconText === 'add_photo_alternate' || iconText === 'upload';
    });

    if (byPlusIcon.length > 0) {
        return byPlusIcon.sort((a, b) => {
            const ar = a.getBoundingClientRect();
            const br = b.getBoundingClientRect();
            if (Math.abs(ar.top - br.top) > 6) return br.top - ar.top;
            return ar.left - br.left;
        })[0];
    }

    const submitBtn = getPrimarySubmitButton();
    if (!submitBtn) return null;
    const submitRect = submitBtn.getBoundingClientRect();

    const nearComposerLeft = candidates
        .filter(el => {
            const rect = el.getBoundingClientRect();
            const sameRow = Math.abs(rect.top - submitRect.top) < 160;
            const leftSide = rect.left < submitRect.left;
            const reasonableSize = rect.width <= 80 && rect.height <= 80;
            return sameRow && leftSide && reasonableSize;
        })
        .sort((a, b) => {
            const ar = a.getBoundingClientRect();
            const br = b.getBoundingClientRect();
            if (Math.abs(ar.top - br.top) > 6) return br.top - ar.top;
            return ar.left - br.left;
        });

    return nearComposerLeft[0] || null;
}

async function openAssetPicker(addImageXPaths, attempts = 3) {
    const xpaths = Array.isArray(addImageXPaths) ? addImageXPaths : [addImageXPaths];

    for (let attempt = 0; attempt < attempts; attempt++) {
        let button = null;
        let matchedXPath = '';

        for (const xpath of xpaths) {
            const candidate = getElementByXPath(xpath);
            if (!candidate || !isElementVisible(candidate)) continue;
            if (candidate.disabled || candidate.getAttribute('aria-disabled') === 'true') continue;
            button = candidate;
            matchedXPath = xpath;
            break;
        }

        if (!button) {
            button = findAddImageButton();
        }

        if (clickElementOnce(button)) {
            console.log('[openAssetPicker] Single click attempt ' + (attempt + 1), matchedXPath || 'dynamic');
            if (await waitForAssetModalReady(18, 180)) return true;
        }

        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        await new Promise(r => setTimeout(r, 450 + (attempt * 200)));
    }

    return isAssetModalVisible();
}
async function selectAssetImagesTab(attempts = 4) {
    for (let attempt = 0; attempt < attempts; attempt++) {
        const imageTab = getElementByXPath(ASSET_IMAGES_TAB_XPATH);
        if (!imageTab || !isElementVisible(imageTab)) {
            await new Promise(r => setTimeout(r, 250));
            continue;
        }

        if (clickElementOnce(imageTab)) {
            console.log('[selectAssetImagesTab] Clicked Images tab.');
            await new Promise(r => setTimeout(r, 800));
            return true;
        }

        await new Promise(r => setTimeout(r, 300));
    }

    return false;
}
function hasAttachedImageInComposer(targetFileName) {
    // Wait for all images to attach
    return false;
}

async function waitForAttachedImageInComposer(targetFileName, minExpectedCount = 1, maxAttempts = 24, intervalMs = 250) {
    console.log(`-> [Wait] Waiting for image processing. Target: ${minExpectedCount} images...`);
    for (let i = 0; i < maxAttempts; i++) {
        const currentCount = getAttachedMediaCount();

        if (currentCount >= minExpectedCount) {
            console.log(`-> [Wait] Confirmed ${currentCount}/${minExpectedCount} images attached.`);
    // Brief settle delay for full UI render
            await new Promise(r => setTimeout(r, 300));
            return true;
        }
        await new Promise(r => setTimeout(r, intervalMs));
    }
    console.log(`-> [Wait] Timeout. Detected ${getAttachedMediaCount()}/${minExpectedCount} attached images.`);
    return false;
}

async function openFrameAssetDropdown(slotElement, frameType, assetDropdownXPaths, attempts = 3) {
    for (let attempt = 0; attempt < attempts; attempt++) {
        forceUserLikeClick(slotElement);
        console.log(`[frame-to-video] Clicked ${frameType} frame input (attempt ${attempt + 1})`);
        await new Promise(r => setTimeout(r, 650 + (attempt * 150)));

        const openedDropdown = await forceClickAnyXPath(assetDropdownXPaths, 650);
        if (openedDropdown) {
            console.log(`[frame-to-video] Opened dropdown for ${frameType} frame`);
            return true;
        }

        console.warn(`[frame-to-video] Retry opening dropdown for ${frameType} frame...`);
        await new Promise(r => setTimeout(r, 250));
    }

    return false;
}

function pickBestRecentAssetCard(cards, targetFileName, promptText, excludedKeys = new Set()) {
    const targetKey = normalizeName(targetFileName || '');
    const promptKey = normalizeName(promptText || '');
    if (!Array.isArray(cards) || cards.length === 0) return null;

    const available = cards
        .map(card => {
            const rawName = getAssetNameFromCard(card);
            const nameKey = normalizeName(rawName);
            const cardKey = getAssetCardKey(card);
            return { card, rawName, nameKey, cardKey };
        })
        .filter(item => item.cardKey && !excludedKeys.has(item.cardKey));

    if (available.length === 0) return null;

    if (targetKey) {
        const exact = available.find(item => item.nameKey && item.nameKey === targetKey);
        if (exact) {
            return { card: exact.card, score: 999, rawName: exact.rawName, cardKey: exact.cardKey };
        }

        const include = available.find(item => item.nameKey && (item.nameKey.includes(targetKey) || targetKey.includes(item.nameKey)));
        if (include) {
            return { card: include.card, score: 600, rawName: include.rawName, cardKey: include.cardKey };
        }
    }

    let best = null;
    for (const item of available) {
        const { card, rawName, nameKey, cardKey } = item;
        if (!nameKey) continue;

        let score = 0;
        if (targetKey && nameKey === targetKey) score += 200;
        if (promptKey && (promptKey.includes(nameKey) || nameKey.includes(promptKey))) score += 100;

        const tokens = promptKey.split(' ').filter(token => token.length >= 2);
        if (tokens.some(token => nameKey.includes(token))) score += 35;

        if (!best || score > best.score) {
            best = { card, score, rawName, cardKey };
        }
    }

    if (best && best.score > 0) return best;

    const firstAvailable = available[0];
    if (!firstAvailable) return null;
    return {
        card: firstAvailable.card,
        score: best?.score || 0,
        rawName: firstAvailable.rawName,
        cardKey: firstAvailable.cardKey
    };
}

async function waitForBestRecentAssetCard(targetFileName, promptText, excludedKeys = new Set(), maxAttempts = 45, intervalMs = 260) {
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
        const cards = getRecentAssetCards();
        if (cards.length > 0) {
            const picked = pickBestRecentAssetCard(cards, targetFileName, promptText, excludedKeys);
            if (picked) return picked;
        }
        await new Promise(r => setTimeout(r, intervalMs));
    }
    return null;
}

async function waitForRecentAssets(maxAttempts = 18, intervalMs = 220) {
    for (let i = 0; i < maxAttempts; i++) {
        const cards = getRecentAssetCards();
        if (cards.length > 0) return cards;
        await new Promise(r => setTimeout(r, intervalMs));
    }
    return [];
}

async function autoAttachFrameImage(promptText, uploadedFiles, groupId, index, selectedMode = '', promptImageNames = [], maxInputImagesPerPrompt = 3) {
    // Wait for any previous image attachment to complete (serialize picker operations)
    while (imageAttachmentInProgress) {
        await new Promise(r => setTimeout(r, 100));
    }
    imageAttachmentInProgress = true;

    try {
        const normalizedFiles = normalizeIncomingFiles(uploadedFiles);
        const safeMode = String(selectedMode || '').toLowerCase();
        const isFrameToVideoMode = safeMode.includes('frame-to-video') || safeMode.includes('frame to video');
        const isIngredientsVideoMode = safeMode.includes('ingredients-to-video') || safeMode.includes('ingredients to video');
        const isIngredientsImageMode = safeMode.includes('ingredients-to-image') || safeMode.includes('ingredients to image');
        const isIngredientsMode = isIngredientsVideoMode || isIngredientsImageMode;
        // Set max images for Ingredients
        let maxImagesPerPrompt = 3;
        if (isIngredientsMode) {
            maxImagesPerPrompt = Number.isFinite(+maxInputImagesPerPrompt) ? Math.max(1, Math.min(3, parseInt(maxInputImagesPerPrompt, 10))) : 3;
            console.log(`-> [Ingredients Mode] Max allowable attached images: ${maxImagesPerPrompt}`);
        } else if (isFrameToVideoMode) {
            maxImagesPerPrompt = 2; // Frame mode supports First/Last (max 2)
        } else {
            maxImagesPerPrompt = 10; // Other modes
        }

        const exactPlanNames = Array.isArray(promptImageNames)
            ? promptImageNames.map(name => String(name || '').trim()).filter(Boolean)
            : [];

        // Pass maxImagesPerPrompt to picker
        const matchedFiles = exactPlanNames.length > 0
            ? pickExactFilesByNames(normalizedFiles, exactPlanNames, maxImagesPerPrompt)
            : pickMatchedFilesForPrompt(promptText, normalizedFiles, maxImagesPerPrompt);

        // Debug logging
        console.log(`[autoAttachFrameImage] Prompt ${index}:`, {
            uploadedFilesCount: normalizedFiles.length,
            uploadedFileNames: normalizedFiles.map(f => f.name),
            promptImageNames: promptImageNames,
            exactPlanNames: exactPlanNames,
            selectedFilesCount: matchedFiles.length,
            selectedFileNames: matchedFiles.map(f => f.name)
        });

        if (matchedFiles.length === 0) {
            if (exactPlanNames.length > 0) {
                safeSendQueueStatus({ groupId, index, status: 'Not enough images matched for prompt preview ⚠️', percent: 0 });
            } else {
                safeSendQueueStatus({ groupId, index, status: 'No image matching prompt name found ⚠️', percent: 0 });
            }
            return false;
        }

        safeSendQueueStatus({ groupId, index, status: `Attaching ${matchedFiles.length} images to prompt…`, percent: 0 });

        let attachedCount = 0;

        // Detect image processing mode for frame-to-video
        let frameImageMode = 'first'; // 'first' or 'first_and_last'

        if (isFrameToVideoMode) {
            // Detect mode by checking if end frame input is present and enabled
            try {
                const firstFrameXPath = `/html/body/div[1]/div[1]/div[5]/div/div/div[1]/div[1]`;
                const endFrameXPath = `/html/body/div[1]/div[1]/div[5]/div/div/div[1]/div[2]`;

                const firstFrameEl = document.evaluate(
                    firstFrameXPath,
                    document,
                    null,
                    XPathResult.FIRST_ORDERED_NODE_TYPE,
                    null
                ).singleNodeValue;

                const endFrameEl = document.evaluate(
                    endFrameXPath,
                    document,
                    null,
                    XPathResult.FIRST_ORDERED_NODE_TYPE,
                    null
                ).singleNodeValue;

                // Check if end frame exists and is visible/enabled
                const endFrameExists = endFrameEl && isElementVisible(endFrameEl) && !endFrameEl.hidden && endFrameEl.offsetHeight > 0;
                const firstFrameExists = firstFrameEl && isElementVisible(firstFrameEl) && !firstFrameEl.hidden && firstFrameEl.offsetHeight > 0;

                if (firstFrameExists && endFrameExists) {
                    frameImageMode = 'first_and_last';
                    console.log(`[autoAttachFrameImage] ✓ Detected 'first_and_last' mode - BOTH frame inputs present`);
                } else if (firstFrameExists) {
                    frameImageMode = 'first';
                    console.log(`[autoAttachFrameImage] → Detected 'first' mode - only first frame input visible`);
                } else {
                    console.log(`[autoAttachFrameImage] ⚠️  Frame inputs not found at expected paths`);
                }
                console.log(`[autoAttachFrameImage] Frame mode: ${frameImageMode}, Images to process: ${matchedFiles.length}`);
            } catch (e) {
                console.log(`[autoAttachFrameImage] Could not detect frame mode:`, e);
            }
        }

        const addImageXPaths = getAddImageButtonXPaths();
        const firstFrameInputXPath = '/html/body/div[1]/div[1]/div[5]/div/div/div[1]/div[1]';
        const lastFrameInputXPath = '/html/body/div[1]/div[1]/div[5]/div/div/div[1]/div[2]';
        const assetDropdownXPaths = [
            '/html/body/div[1]/div[2]/div/div/div/div[1]/button[2]',
            '/html/body/div[1]/div[2]/div/div/div/div[1]/div/button',
            '/html/body/div[1]/div[3]/div/div/div/div[1]/button[2]',
            '/html/body/div[1]/div[3]/div/div/div/div[1]/div/button'
        ];
        const newestOptionXPaths = [
            '/html/body/div[3]/div/button[3]',
            '/html/body/div[4]/div/button[3]'
        ];
        const selectedAssetKeys = new Set();

        // For frame-to-video mode: directly fill first/last frame inputs
        if (isFrameToVideoMode) {
            const firstFrameInput = getElementByXPath(firstFrameInputXPath);
            const lastFrameInput = getElementByXPath(lastFrameInputXPath);

            if (!firstFrameInput && !lastFrameInput) {
                safeSendQueueStatus({ groupId, index, status: 'Input field for first/last frame not found ⚠️', percent: 0 });
                return false;
            }

            for (let i = 0; i < matchedFiles.length; i++) {
                const matchedFile = matchedFiles[i];
                const isFirstImage = (i === 0);
                const isLastImage = (i === matchedFiles.length - 1);

                // Determine if this image should be processed
                let frameType = null; // 'first', 'last', or null (skip)
                let inputElement = null;

                if (frameImageMode === 'first') {
                    // In 'first' mode: only process first image
                    if (isFirstImage) {
                        frameType = 'first';
                        inputElement = firstFrameInput;
                    }
                } else if (frameImageMode === 'first_and_last') {
                    // In 'first_and_last' mode: process first and last images
                    if (isFirstImage) {
                        frameType = 'first';
                        inputElement = firstFrameInput;
                    } else if (isLastImage) {
                        frameType = 'last';
                        inputElement = lastFrameInput;
                    }
                }

                // Skip this image if it's not target frame
                if (!frameType || !inputElement) {
                    console.log(`[autoAttachFrameImage] ⊘ Skipping image ${i + 1}/${matchedFiles.length} (not target frame)`);
                    continue;
                }

                // Process this frame
                const isProcessingFirst = (frameType === 'first');
                console.log(`[autoAttachFrameImage] → Processing ${frameType} frame (image ${i + 1}/${matchedFiles.length}): ${matchedFile.name}`);

                try {
                    safeSendQueueStatus({ groupId, index, status: `Selecting ${frameType} frame image: ${matchedFile.name}…`, percent: 0 });
                    const beforeAttachmentCount = getAttachedMediaCount();

                    // Step 1-2: Open dropdown with retry
                    safeSendQueueStatus({ groupId, index, status: `Opening image dropdown…`, percent: 0 });
                    const openedDropdown = await openFrameAssetDropdown(inputElement, frameType, assetDropdownXPaths, 3);
                    if (!openedDropdown) {
      console.log(`[frame-to-video] ❌ Failed to click dropdown button for ${frameType} frame`);
                        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
                        await new Promise(r => setTimeout(r, 200));
                        continue;
                    }

                    await new Promise(r => setTimeout(r, 500));

                    // Step 3: Click "Newest" button
                    safeSendQueueStatus({ groupId, index, status: `Finding newest image…`, percent: 0 });
                    let clickedNewest = false;
                    for (let newestRetry = 0; newestRetry < 3 && !clickedNewest; newestRetry++) {
                        clickedNewest = await forceClickAnyXPath(newestOptionXPaths, 900);
                        if (!clickedNewest && newestRetry < 2) {
                            await new Promise(r => setTimeout(r, 400));
                        }
                    }
                    if (!clickedNewest) {
      console.log(`[frame-to-video] ❌ Failed to click Newest button for ${frameType} frame`);
                        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
                        await new Promise(r => setTimeout(r, 200));
                        continue;
                    }
                    console.log(`[frame-to-video] ✓ Clicked Newest button, waiting for images to load`);

                    // Step 4: Wait for image load
                    await new Promise(r => setTimeout(r, 1200));

                    // Step 5: Select image from Recent
                    safeSendQueueStatus({ groupId, index, status: `Finding matching image…`, percent: 0 });
                    const cards = await waitForRecentAssets(40, 300);
                    if (cards.length === 0) {
      console.log(`[frame-to-video] ❌ No recent images found for ${frameType} frame`);
                        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
                        await new Promise(r => setTimeout(r, 200));
                        continue;
                    }
      console.log(`[frame-to-video] 🔍 Found ${cards.length} recent images`);

                    const picked = await waitForBestRecentAssetCard(matchedFile.name, promptText, selectedAssetKeys, 50, 300);
                    if (!picked) {
      console.log(`[frame-to-video] ❌ Image ${matchedFile.name} not found in Recent`);
                        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
                        await new Promise(r => setTimeout(r, 200));
                        continue;
                    }

                    safeSendQueueStatus({ groupId, index, status: `Selecting image: ${picked.rawName}…`, percent: 0 });
                    const clickedAsset = clickRecentAssetCard(picked.card);
                    if (!clickedAsset) {
      console.log(`[frame-to-video] ❌ Failed to click image card`);
                        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
                        await new Promise(r => setTimeout(r, 200));
                        continue;
                    }

                    await new Promise(r => setTimeout(r, 300));
                    await clickAssetConfirmButton();
                    await new Promise(r => setTimeout(r, 420));

                    const slotReady = await waitForFrameSlotAttachment(frameType, inputElement, 1, 30, 240);

                    if (!slotReady) {
      console.log(`[frame-to-video] ⚠️ Slot ${frameType} did not register image: ${matchedFile.name}`);
                        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
                        await new Promise(r => setTimeout(r, 220));
                        continue;
                    }

                    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
                    await new Promise(r => setTimeout(r, 300));

      console.log(`[frame-to-video] ✅ Filled image ${frameType}: ${matchedFile.name}`);
                    attachedCount++;
                    if (picked.cardKey) {
                        selectedAssetKeys.add(picked.cardKey);
                    } else {
                        selectedAssetKeys.add(`name:${normalizeName(picked.rawName || matchedFile.name)}`);
                    }

                } catch (e) {
                    console.error(`[frame-to-video] Error filling ${frameType} frame:`, e);
                    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
                }
            }

            // Frame-to-video done - release lock before returning
            imageAttachmentInProgress = false;
            if (attachedCount > 0) {
                safeSendQueueStatus({ groupId, index, status: `Attached ${attachedCount} frame images to prompt 🖼️`, percent: 0 });
                return true;
            } else {
                safeSendQueueStatus({ groupId, index, status: 'Could not attach frame images to prompt ⚠️', percent: 0 });
                return false;
            }
        }

        // For ingredients/text-to-video mode: continue with original logic below
        for (let fileIdx = 0; fileIdx < matchedFiles.length; fileIdx++) {
            const matchedFile = matchedFiles[fileIdx];
            const beforeAttachmentCount = getAttachedMediaCount();

            console.log(`[autoAttachFrameImage] 📸 Processing file ${fileIdx + 1}/${matchedFiles.length}: ${matchedFile.name}`);
            safeSendQueueStatus({ groupId, index, status: `Opening image selection (${fileIdx + 1}/${matchedFiles.length}): ${matchedFile.name}…`, percent: 0 });

            // Reset: Close any open modals from previous iteration
            if (fileIdx > 0) {
                console.log(`[autoAttachFrameImage] Reset: Closing modals from previous file...`);
                document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
                await new Promise(r => setTimeout(r, 300));
                document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
                await new Promise(r => setTimeout(r, 200));
            }

            // Step 1: Open image picker and confirm
            console.log('[autoAttachFrameImage] B1: open picker via ' + addImageXPaths.length + ' XPath variants');
            const openedPicker = await openAssetPicker(addImageXPaths, 3);
            if (!openedPicker) {
                console.log('[autoAttachFrameImage] B1 failed: picker did not open after verified single-click attempts');
                safeSendQueueStatus({ groupId, index, status: 'Error: Could not click add image button for ' + matchedFile.name + ' ⚠️', percent: 0 });
                document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
                await new Promise(r => setTimeout(r, 300));
                continue;
            }
            console.log('[autoAttachFrameImage] B1 success: asset picker is visible');
            // Wait for asset dropdown to render after opening picker
            await new Promise(r => setTimeout(r, 500));

            // Ensure asset modal is fully rendered with buttons visible
            await waitForAssetModalReady(20, 150);

            // B2: open the Images tab before selecting an asset.
            safeSendQueueStatus({ groupId, index, status: 'Opening Images tab…', percent: 0 });
            const imageTabSelected = await selectAssetImagesTab(4);
            if (!imageTabSelected) {
                console.log('[autoAttachFrameImage] B2 failed: Images tab button was not available');
                safeSendQueueStatus({ groupId, index, status: 'Error: Could not open Images tab ⚠️', percent: 0 });
                document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
                await new Promise(r => setTimeout(r, 300));
                continue;
            }

            // The current Flow UI shows image cards directly after selecting Images.
            let cards = await waitForRecentAssets(20, 240);

            // Legacy fallback: open source dropdown and choose Newest only when cards are absent.
            if (cards.length === 0) {
                const dropdownButton = assetDropdownXPaths
                    .map(xpath => getElementByXPath(xpath))
                    .find(el => el && isElementVisible(el) && !el.disabled && el.getAttribute('aria-disabled') !== 'true');

                if (clickElementOnce(dropdownButton)) {
                    await new Promise(r => setTimeout(r, 500));

                    const newestButton = newestOptionXPaths
                        .map(xpath => getElementByXPath(xpath))
                        .find(el => el && isElementVisible(el) && !el.disabled && el.getAttribute('aria-disabled') !== 'true');

                    if (clickElementOnce(newestButton)) {
                        await new Promise(r => setTimeout(r, 700));
                        cards = await waitForRecentAssets(20, 240);
                    }
                }
            }
            if (cards.length === 0) {
                console.log(`[autoAttachFrameImage] ✗ B4 failed: no recent assets found`);
                safeSendQueueStatus({ groupId, index, status: `No recent image found for ${matchedFile.name} ⚠️`, percent: 0 });
                document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
                await new Promise(r => setTimeout(r, 320));
                document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
                await new Promise(r => setTimeout(r, 200));
                continue;
            }

            const picked = await waitForBestRecentAssetCard(matchedFile.name, promptText, selectedAssetKeys, 36, 240);
            if (!picked) {
                console.log(`[autoAttachFrameImage] ✗ B4 failed: best asset card not found for ${matchedFile.name}`);
                safeSendQueueStatus({ groupId, index, status: `Image ${matchedFile.name} not found in Recent ⚠️`, percent: 0 });
                document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
                await new Promise(r => setTimeout(r, 320));
                document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
                await new Promise(r => setTimeout(r, 200));
                continue;
            }

            safeSendQueueStatus({ groupId, index, status: `Selecting image: ${picked.rawName}…`, percent: 0 });
            const clickedAsset = clickRecentAssetCard(picked.card);
            if (!clickedAsset) {
                console.log(`[autoAttachFrameImage] ✗ B4 failed: couldn't click asset card`);
                safeSendQueueStatus({ groupId, index, status: `Could not click image card for ${matchedFile.name} ⚠️`, percent: 0 });
                document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
                await new Promise(r => setTimeout(r, 320));
                document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
                await new Promise(r => setTimeout(r, 200));
                continue;
            }
            await new Promise(r => setTimeout(r, 180));

            await clickAssetConfirmButton();
            let attachedReady = await waitForAttachedImageInComposer(
                picked.rawName,
                beforeAttachmentCount + 1,
                14,
                220
            );

            if (!attachedReady) {
                await clickAssetConfirmButton();
                await new Promise(r => setTimeout(r, 180));
                attachedReady = await waitForAttachedImageInComposer(
                    picked.rawName,
                    beforeAttachmentCount + 1,
                    14,
                    220
                );
            }

            if (!attachedReady) {
                console.log(`[autoAttachFrameImage] ✗ Image not attached after confirm: ${matchedFile.name}`);
                safeSendQueueStatus({ groupId, index, status: `Image ${matchedFile.name} not attached to input ⚠️`, percent: 0 });
                document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
                await new Promise(r => setTimeout(r, 320));
                document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
                await new Promise(r => setTimeout(r, 200));
                continue;
            }

            console.log(`[autoAttachFrameImage] ✓ File ${fileIdx + 1} successfully attached: ${matchedFile.name}`);
            attachedCount++;
            if (picked.cardKey) {
                selectedAssetKeys.add(picked.cardKey);
            } else {
                selectedAssetKeys.add(`name:${normalizeName(picked.rawName || matchedFile.name)}`);
            }
            safeSendQueueStatus({ groupId, index, status: `Attached ${attachedCount}/${matchedFiles.length} images ✅`, percent: 0 });

            document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
            await new Promise(r => setTimeout(r, 220));
        }

        if (attachedCount === 0) {
            safeSendQueueStatus({ groupId, index, status: 'Could not attach any image to prompt ⚠️', percent: 0 });
            imageAttachmentInProgress = false;
            return false;
        }

        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        await new Promise(r => setTimeout(r, 300));
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        await new Promise(r => setTimeout(r, 200));

        safeSendQueueStatus({ groupId, index, status: `Attached ${attachedCount}/${matchedFiles.length} images to prompt 🖼️`, percent: 0 });
        imageAttachmentInProgress = false;
        return true;
    } catch (error) {
        console.error('[autoAttachFrameImage] Unexpected error:', error);
        safeSendQueueStatus({ groupId, index, status: `Image attach error: ${error.message || 'unknown'} ❌`, percent: 0 });
        imageAttachmentInProgress = false;
        return false;
    }
}

async function preUploadImagesToFlow(uploadedFiles, groupId) {
    const normalizedFiles = normalizeIncomingFiles(uploadedFiles);
    if (normalizedFiles.length === 0) return true;

    const openAssetsXPath = '/html/body/div[1]/div[1]/div[2]/div/div[2]/div/button[1]';
    const uploadBtnXPath = '/html/body/div[3]/div/button[1]';

    safeSendQueueStatus({ groupId, index: 0, status: `Opening asset library to upload ${normalizedFiles.length} images…`, percent: 0 });

    let openedAssets = await forceClickXPath(openAssetsXPath, 600);
    if (!openedAssets) {
        const alreadyOpen = isAssetModalVisible() || await waitForImageInputAvailable(3, 160);
        if (alreadyOpen) {
            openedAssets = true;
        }
    }

    if (!openedAssets) {
        safeSendQueueStatus({ groupId, index: 0, status: 'Could not open asset library ❌', percent: 0 });
        return false;
    }

    await waitForImageInputAvailable(10, 200);
    let uploaded = await injectFilesToNewestInput(normalizedFiles, 10);

    if (!uploaded) {
        const openedUpload = await forceClickXPath(uploadBtnXPath, 300);
        if (openedUpload) {
            await waitForImageInputAvailable(12, 200);
            uploaded = await injectFilesToNewestInput(normalizedFiles, 10);
        }
    }

    if (!uploaded) {
        safeSendQueueStatus({ groupId, index: 0, status: 'System file picker opened. Please select file manually once ⚠️', percent: 0 });
        return false;
    }

    await new Promise(r => setTimeout(r, 1200));
    safeSendQueueStatus({ groupId, index: 0, status: `Uploaded ${normalizedFiles.length} images to Flow ✅`, percent: 0 });
    return true;
}

// ==========================================
// HANDLE PROMPT COMPLETION WITH AUTO-DOWNLOAD
// ==========================================

/**
 * When a prompt completes, automatically download all its results
 * This finds result cards for this prompt and triggers downloads with proper error handling
 */
    // Retain lock until next batch starts
const _downloadDone = new Set(); // Prevent duplicate downloads
const _downloadedTileIds = new Set(); // Prevent tile download collisions

function resetPromptDownloadLock(groupId, promptIndex) {
    _downloadDone.delete(`${groupId}:${promptIndex}`);
}

async function handlePromptCompletionDownload(promptIndex, groupId, selectedMode = '') {
    const lockKey = `${groupId}:${promptIndex}`;
    if (_downloadDone.has(lockKey)) {
        console.log(`[handlePromptCompletion] Already downloaded, skipping: ${lockKey}`);
        return true;
    }
    _downloadDone.add(lockKey);

    try {
        const settings = await getDownloadSettings(selectedMode);
        const { videoQuality, imageQuality, folderName } = settings;

        const safeMode = String(selectedMode || '').toLowerCase();
        const isImgMode = safeMode.includes('image') && !safeMode.includes('video');
        const selectedQuality = isImgMode ? imageQuality : videoQuality;

        if (selectedQuality === 'none') return true;

        const outputCount = _currentOutputCount;

        if (isImgMode) {
            console.log(`[handlePromptCompletion] Preparing image download for prompt ${promptIndex + 1}...`);
            await new Promise(r => setTimeout(r, 1200));
        } else {
            console.log(`[handlePromptCompletion] Waiting 7s for video render settling...`);
            safeSendQueueStatus({ groupId, index: promptIndex, status: "Waiting for video sync... ⏳", percent: 100 });
            await new Promise(r => setTimeout(r, 7000));
        }

        const isCardError = (el) => {
            return isFlowFailureText(el.textContent || '');
        };

        const isCardStillRunning = (el) => {
            if (!el || !isElementVisible(el)) return false;
            return isFlowPendingText(el.textContent || '');
        };

        const isCardClickable = (el) => {
            if (!isElementVisible(el)) return false;
            if (isCardError(el)) return false;
            if (isCardStillRunning(el)) return false;

            const hasMedia = !!el.querySelector('img, video, canvas');
            const hasAction = !!el.querySelector('button, [role="button"], a[href]');
            const hasPlayIcon = Array.from(el.querySelectorAll('i, .material-icons, .google-symbols'))
                .some(icon => (icon.textContent || '').trim().toLowerCase().includes('play'));

            if (isImgMode) return hasMedia;
            return hasMedia && hasAction && hasPlayIcon;
        };

        const getAllUniqueCardsInDomOrder = () => {
            const tileMap = new Map();
            Array.from(document.querySelectorAll('[data-tile-id]'))
                .filter(el => isElementVisible(el))
                .forEach(el => {
                    const id = el.getAttribute('data-tile-id');
                    if (id && !tileMap.has(id)) tileMap.set(id, el);
                });
            return Array.from(tileMap.values());
        };

        const ownerKey = `${String(groupId)}:${promptIndex}`;
        const snapshotKey = `${String(groupId)}:${promptIndex}:snapshot`;
        const tileSnapshots = monitorVideoProgress._tileSnapshot || new Map();
        const beforeSnapshot = tileSnapshots.get(snapshotKey) instanceof Set
            ? tileSnapshots.get(snapshotKey)
            : new Set();

        const getCardsFromOwnerRow = () => {
            const ownedCardsMap = new Map();
            Array.from(document.querySelectorAll(`[data-veo-owner="${ownerKey}"]`))
                .filter(el => isElementVisible(el))
                .forEach(el => {
                    const card = el.closest('[data-tile-id]') || el;
                    const id = card.getAttribute?.('data-tile-id') || el.getAttribute?.('data-tile-id') || '';
                    if (id && !ownedCardsMap.has(id)) ownedCardsMap.set(id, card);
                });

            return sortCardsOldestFirst(Array.from(ownedCardsMap.values()));
        };

        const getCardsFromSnapshotDiff = () => {
            const allCards = getAllUniqueCardsInDomOrder();
            return allCards.filter(card => {
                const id = card.getAttribute('data-tile-id');
                return id && !beforeSnapshot.has(id);
            });
        };

        const isCardFromCurrentPrompt = (card) => {
            const id = card?.getAttribute?.('data-tile-id') || '';
            if (!id) return true;
            return !beforeSnapshot.has(id);
        };

        const toNumberOrFallback = (value, fallback = 0) => {
            const n = Number.parseInt(String(value ?? ''), 10);
            return Number.isFinite(n) ? n : fallback;
        };

        const getRowOrderScore = (el) => {
            const row = el?.closest?.('[data-index][data-item-index]');
            if (row) {
                // Flow displays newest items at lower indexes.
                // To process chronologically, prioritize higher index.
                return toNumberOrFallback(row.getAttribute('data-index'), -1);
            }
            const rect = el?.getBoundingClientRect?.();
            return Math.floor(rect?.top || 0);
        };

        const sortCardsOldestFirst = (cards) => {
            return [...cards].sort((a, b) => {
                const rowDiff = getRowOrderScore(b) - getRowOrderScore(a);
                if (rowDiff !== 0) return rowDiff;

                const ar = a.getBoundingClientRect();
                const br = b.getBoundingClientRect();

                // Tie-breaker: left-to-right order
                const topDiff = (br.top || 0) - (ar.top || 0);
                if (Math.abs(topDiff) > 2) return topDiff;
                return (ar.left || 0) - (br.left || 0);
            });
        };

        const getCardsFromCompletedRow = () => {
            const rows = Array.from(document.querySelectorAll('[data-index][data-item-index]'))
                .filter(row => isElementVisible(row))
                .sort((a, b) => {
                    const ai = toNumberOrFallback(a.getAttribute('data-index'), -1);
                    const bi = toNumberOrFallback(b.getAttribute('data-index'), -1);
                    return bi - ai; // chronological order
                });

            for (const row of rows) {
                const rowCardsMap = new Map();
                Array.from(row.querySelectorAll('[data-tile-id]'))
                    .filter(el => isElementVisible(el))
                    .forEach(el => {
                        const owner = el.getAttribute('data-veo-owner');
                        if (owner && owner !== ownerKey) return;
                        const id = el.getAttribute('data-tile-id');
                        if (id && !rowCardsMap.has(id)) rowCardsMap.set(id, el);
                    });

                const rowCards = sortCardsOldestFirst(Array.from(rowCardsMap.values()));
                if (rowCards.length < outputCount) continue;

                const hasForeignOwner = rowCards.some(card => {
                    const owner = card.getAttribute('data-veo-owner');
                    return owner && owner !== ownerKey;
                });
                if (hasForeignOwner) continue;

                const hasPromptOwnedCard = rowCards.some(card => card.getAttribute('data-veo-owner') === ownerKey);
                if (hasPromptOwnedCard) {
                    const promptOwnedNewCards = rowCards.filter(card => {
                        if (card.getAttribute('data-veo-owner') !== ownerKey) return false;
                        return isCardFromCurrentPrompt(card);
                    });
                    if (promptOwnedNewCards.length === 0) continue;
                }

                const rowHasAnyCurrentPromptCard = rowCards.some(card => isCardFromCurrentPrompt(card));
                if (!rowHasAnyCurrentPromptCard) continue;

                const unresolved = rowCards.some(card => !isCardClickable(card) && !isCardError(card));
                if (unresolved) continue;

                const hasFreshTile = rowCards.some(card => {
                    const id = card.getAttribute('data-tile-id') || '';
                    return id && !_downloadedTileIds.has(id);
                });

                if (hasFreshTile) return rowCards;
            }

            return [];
        };

        let targetCards = [];
        const maxWaitMs = 60000; // 60s max wait
        const pollMs = 1000;
        const startWaitAt = Date.now();

        console.log(`[handlePromptCompletion] Waiting for cards of prompt ${promptIndex} (output=${outputCount})...`);

        while (Date.now() - startWaitAt < maxWaitMs) {
            const ownerRowCards = getCardsFromOwnerRow();
            const completedRowCards = getCardsFromCompletedRow();
            const diffCards = getCardsFromSnapshotDiff();
            const elapsed = Date.now() - startWaitAt;
            let sourceCards = [];

            const ownerCardsForPrompt = ownerRowCards.filter(card => isCardFromCurrentPrompt(card));

            const ownerFreshCount = ownerCardsForPrompt.filter(card => {
                const tileId = card.getAttribute('data-tile-id') || '';
                return !tileId || !_downloadedTileIds.has(tileId);
            }).length;

            if (ownerCardsForPrompt.length > 0 && ownerFreshCount > 0) {
                sourceCards = ownerCardsForPrompt;
            } else if (completedRowCards.length > 0) {
                sourceCards = completedRowCards;
            } else if (elapsed >= 10000) {
                sourceCards = diffCards;
            }

            const ready = sourceCards.filter(card => isCardClickable(card) || isCardError(card));
            const successful = ready.filter(card => isCardClickable(card));
            const unseenSuccessful = successful.filter(card => {
                const tileId = card.getAttribute('data-tile-id') || '';
                return !tileId || !_downloadedTileIds.has(tileId);
            });
            const hasUnresolved = sourceCards.some(card => !isCardClickable(card) && !isCardError(card));

            const errCount = ready.filter(card => isCardError(card)).length;

            console.log(`[handlePromptCompletion] Poll: source=${sourceCards.length}, ready=${ready.length}, success=${successful.length}, fresh=${unseenSuccessful.length}, errors=${errCount}, unresolved=${hasUnresolved}, elapsed=${elapsed}ms`);

            if (!hasUnresolved && unseenSuccessful.length > 0) {
                targetCards = sortCardsOldestFirst(unseenSuccessful).slice(0, outputCount);
                console.log(`[handlePromptCompletion] Cards completed after ${Date.now() - startWaitAt}ms, download=${targetCards.length}/${ready.length}`);
                break;
            }

            if (!hasUnresolved && sourceCards.length > 0 && errCount === sourceCards.length) {
                console.log(`[handlePromptCompletion] All result cards are Flow failures. errCount=${errCount}/${sourceCards.length}`);
                markPromptRenderFailure(groupId, promptIndex);
                return false;
            }

            await new Promise(r => setTimeout(r, pollMs));
        }

        if (targetCards.length === 0) {
            const ownerRowCards = getCardsFromOwnerRow();
            const completedRowCards = getCardsFromCompletedRow();
            const diffCards = getCardsFromSnapshotDiff();
            const ownerCardsForPrompt = ownerRowCards.filter(card => isCardFromCurrentPrompt(card));
            const sourceCards = ownerCardsForPrompt.length > 0
                ? ownerCardsForPrompt
                : (completedRowCards.length > 0 ? completedRowCards : diffCards);
            const errCount = sourceCards.filter(isCardError).length;
            const stillRunning = sourceCards.some(card => isCardStillRunning(card) || (!isCardClickable(card) && !isCardError(card)));
            console.log(`[handlePromptCompletion] No downloadable card before timeout. errCount=${errCount}/${sourceCards.length}, stillRunning=${stillRunning}`);
            if (sourceCards.length > 0 && errCount === sourceCards.length) {
                markPromptRenderFailure(groupId, promptIndex);
                return false;
            }
            return true;
        }

        // ============================================================
    // Sequential download (800ms interval)
        // ============================================================
        let downloadCount = 0;

    // Filter to verify successful outputs before download
        const successfulCards = targetCards
            .filter(card => isCardFromCurrentPrompt(card))
            .filter(card => isCardClickable(card) && !isCardError(card))
            .filter(card => {
                const tileId = card.getAttribute('data-tile-id') || '';
                return !tileId || !_downloadedTileIds.has(tileId);
            })
            .sort((a, b) => {
                const rowDiff = getRowOrderScore(b) - getRowOrderScore(a);
                if (rowDiff !== 0) return rowDiff;
                const ar = a.getBoundingClientRect();
                const br = b.getBoundingClientRect();
                const topDiff = (br.top || 0) - (ar.top || 0);
                if (Math.abs(topDiff) > 2) return topDiff;
                return (ar.left || 0) - (br.left || 0);
            })
            .slice(0, outputCount);

        console.log(`[handlePromptCompletion] Preparing download of ${successfulCards.length} successful items (of ${targetCards.length} total)...`);

        for (let i = 0; i < successfulCards.length; i++) {
            const tileId = successfulCards[i].getAttribute('data-tile-id') || '';
            const ok = await autoDownloadResult(
                promptIndex + 1, folderName, !isImgMode, selectedQuality, successfulCards[i]
            );
            if (ok) {
                downloadCount++;
                if (tileId) {
                    _downloadedTileIds.add(tileId);
                }
            }

            // Wait 1.5s for Chrome download dispatch
            if (i < successfulCards.length - 1) {
                await new Promise(r => setTimeout(r, 3000));
            }
        }

    console.log(`[handlePromptCompletion] ✅ Downloaded ${downloadCount}/${successfulCards.length} items.`);

        return successfulCards.length > 0;
    } catch (error) {
        console.error('[handlePromptCompletion] Error:', error);
        return true;
    }
}

// ==========================================
// AUTO DOWNLOAD VIDEO/IMAGE FUNCTIONS
// ==========================================

/**
 * Get download settings from popup storage
 */
function getDownloadSettings(currentMode = '') {
    return new Promise((resolve) => {
        try {
            chrome.storage.local.get(['veo_auto_settings', 'veo_download_subfolder'], (result) => {
                const settings = result.veo_auto_settings || {};
                const videoQuality = settings['auto-download-video-quality'] || '720p';
                const imageQuality = settings['auto-download-image-quality'] || '1k';

                let folderName = '';
                const safeMode = String(currentMode || '').toLowerCase().trim();
                if (safeMode) {
                    const key = `save-to-folder-${safeMode}`;
                    if (settings[key]) {
                        folderName = settings[key];
                    }
                }

                if (!folderName) {
                    for (const mode of ['text-to-image', 'text-to-video', 'frame-to-video', 'ingredients-to-video', 'ingredients-to-image']) {
                        const key = `save-to-folder-${mode}`;
                        if (settings[key]) {
                            folderName = settings[key];
                            break;
                        }
                    }
                }

                if (!folderName && result.veo_download_subfolder) {
                    folderName = result.veo_download_subfolder;
                }
                folderName = folderName || 'veo-folder-1';

                console.log(`[getDownloadSettings] Mode: ${safeMode}, Video: ${videoQuality}, Image: ${imageQuality}, Folder: ${folderName}`);
                resolve({ videoQuality, imageQuality, folderName });
            });
        } catch (e) {
            console.log(`[getDownloadSettings] Error:`, e);
            resolve({ videoQuality: '720p', imageQuality: '1k', folderName: 'veo-folder-1' });
        }
    });
}

/**
 * Get quality button index from user's selected quality setting
 * For video: button index for 270p, 720p, 1080p, 4k
 * For image: button index for 1k, 2k, 4k
 */
function getQualityButtonIndex(selectedQuality, isVideo = true) {
    if (isVideo) {
        const videoQualityMap = {
            '270p': 1,
            '720p': 2,
            '1080p': 3,
            '4k': 4
        };
        return videoQualityMap[selectedQuality] || 2; // Default to 720p
    } else {
        const imageQualityMap = {
            '1k': 1,
            '2k': 2,
            '4k': 3
        };
        return imageQualityMap[selectedQuality] || 1; // Default to 1k
    }
}

/**
 * Auto-download video or image with sequential naming
 * promptNumber: Used for sequential file naming (1, 2, 3, etc)
 * folderName: User's configured folder name from "Save to folder"
 * isVideo: true for video, false for image
 * selectedQuality: Quality setting from popup (e.g., '720p', '1k')
 * resultCard: The DOM element containing the result to download
 */

let _currentOutputCount = 1;
let _currentConcurrentCount = 1;

async function runAutomation(request) {
    const {
        groupId,
        prompts = [],
        promptModes = [],
        concurrentCount = 1,
        outputCount = 1,
        minDelay = 20,
        maxDelay = 30,
        maxRetries = 5,
        selectedMode = 'text-to-image',
        videoModel = 'veo-3.1-fast',
        imageModel = 'nano-banana-2',
        aspectRatio = '16:9',
        uploadedFiles = [],
        promptImagePlan = [],
        maxInputImagesPerPrompt = 3,
        masterPrompt = ''
    } = request || {};

    function getEffectivePrompt(pText, mPrompt) {
        if (!mPrompt || !mPrompt.trim()) return pText;
        const mp = mPrompt.trim();
        const pt = (pText || '').trim();
        if (!pt) return mp;
        const sep = /[,.;:]$/.test(mp) ? ' ' : ', ';
        return `${mp}${sep}${pt}`;
    }

    window._promptRegistry = prompts;

    if (!Array.isArray(prompts) || prompts.length === 0) {
        return;
    }

    const groupKey = String(groupId || 'default-group');
    if (runningGroups.has(groupKey)) {
        safeSendQueueStatus({ groupId: groupKey, index: 0, status: 'Already running ⏭️', percent: 0 });
        return;
    }

    const controller = { stopped: false };
    runningGroups.set(groupKey, controller);

    try {
        clearRenderCardOwners();
        _downloadDone.clear();
        _downloadedTileIds.clear();

        try {
            chrome.runtime.sendMessage({ action: 'CLEAR_FILENAME_QUEUE' }).catch(() => { });
        } catch (e) { }

        const safeMode = String(selectedMode || '').toLowerCase();
        const isFrameToVideoMode = safeMode.includes('frame-to-video') || safeMode.includes('frame to video');
        const isIngredientsVideoMode = safeMode.includes('ingredients-to-video') || safeMode.includes('ingredients to video');
        const isIngredientsImageMode = safeMode.includes('ingredients-to-image') || safeMode.includes('ingredients to image');
        const isIngredientsMode = isIngredientsVideoMode || isIngredientsImageMode;
        const hasUploadedFiles = Array.isArray(uploadedFiles) && uploadedFiles.length > 0;
        const safeConcurrentCount = Number.isFinite(+concurrentCount)
            ? Math.max(1, Math.min(6, parseInt(concurrentCount, 10)))
            : 1;
        const safeMaxRetries = Number.isFinite(+maxRetries)
            ? Math.max(1, Math.min(20, parseInt(maxRetries, 10)))
            : 5;

        _currentOutputCount = Number.isFinite(+outputCount) ? Math.max(1, parseInt(outputCount, 10)) : 1;
        _currentConcurrentCount = safeConcurrentCount;

        if ((isFrameToVideoMode || isIngredientsMode) && hasUploadedFiles) {
            safeSendQueueStatus({ groupId, index: 0, status: 'Uploading images to Flow…', percent: 0 });
            const preUploaded = await preUploadImagesToFlow(uploadedFiles, groupId);
            if (!preUploaded) {
                safeSendQueueStatus({ groupId, index: 0, status: 'Could not upload images to Flow ❌', percent: 0 });
                return;
            }

            // Wait for images to fully load and DOM to stabilize (polling with early exit)
            console.log(`[preUploadImagesToFlow] ⏳ Waiting for images to load and DOM to stabilize...`);
            safeSendQueueStatus({ groupId, index: 0, status: 'Waiting for images to load…', percent: 0 });
            const waitStart = Date.now();
            while (Date.now() - waitStart < 8000) {
                await new Promise(r => setTimeout(r, 500));
                if (Date.now() - waitStart >= 1500 && document.querySelector('img, [role="button"]')) break;
            }
            console.log(`[preUploadImagesToFlow] ✓ Ready to continue`);
        }

        await applyInitialSettings(selectedMode, videoModel, imageModel, aspectRatio);
        await new Promise(r => setTimeout(r, 1200));
        await selectOutputQuantity(outputCount);
        await new Promise(r => setTimeout(r, 800));

        const processSinglePrompt = async (index, waitForCompletion = true, deferDownload = false) => {
            if (controller.stopped) {
                safeSendQueueStatus({ groupId: groupKey, index, status: 'Stopped ⛔', percent: 0 });
                return;
            }

            while (promptProcessingInProgress) {
                await new Promise(r => setTimeout(r, 100));
            }
            promptProcessingInProgress = true;

            try {
                const promptText = String(prompts[index] || '').trim();
                if (!promptText) {
                    safeSendQueueStatus({ groupId, index, status: 'Empty prompt ⚠️', percent: 0 });
                    return;
                }

                const effectivePrompt = getEffectivePrompt(promptText, masterPrompt);

                try {
                    const promptSizeKB = (new TextEncoder().encode(effectivePrompt).length) / 1024;
                    if (promptSizeKB > 10) {
                        safeSendQueueStatus({ groupId, index, status: `Large prompt, processing... ⏳`, percent: 0 });
                        await new Promise(r => setTimeout(r, 500));
                    }
                } catch (e) { }

                safeSendQueueStatus({ groupId, index, status: 'Entering prompt ✍️', percent: 0 });

                const promptSpecificImageNames = Array.isArray(promptImagePlan)
                    ? (promptImagePlan[index] || [])
                    : [];

                if ((isFrameToVideoMode || isIngredientsMode) && hasUploadedFiles) {
                    clearAttachedMediaInComposer();
                    await new Promise(r => setTimeout(r, 300));

                    safeSendQueueStatus({ groupId, index, status: 'Attaching image... 🧩', percent: 0 });

                    let attached = await autoAttachFrameImage(
                        promptText,
                        uploadedFiles,
                        groupId,
                        index,
                        selectedMode,
                        promptSpecificImageNames,
                        maxInputImagesPerPrompt
                    );

                    // Frame-to-video requires attached frames before prompt input.
                    if (!attached && isFrameToVideoMode) {
                        safeSendQueueStatus({ groupId, index, status: 'Frame attach attempt 1 failed, retrying... 🔁', percent: 0 });
                        await new Promise(r => setTimeout(r, 700));
                        attached = await autoAttachFrameImage(
                            promptText,
                            uploadedFiles,
                            groupId,
                            index,
                            selectedMode,
                            promptSpecificImageNames,
                            maxInputImagesPerPrompt
                        );
                    }

                    await new Promise(r => setTimeout(r, 800));

                    if (!attached) {
                        if (isFrameToVideoMode) {
                            safeSendQueueStatus({ groupId, index, status: 'Could not attach frame, skipping prompt ❌', percent: 0 });
                            return;
                        }
                        safeSendQueueStatus({ groupId, index, status: 'Image unconfirmed, continuing... ⚠️', percent: 0 });
                    }
                }

                if (isIngredientsMode && !hasUploadedFiles) {
                    safeSendQueueStatus({ groupId, index, status: 'No input image ⏭️', percent: 0 });
                }

                let editor;
                try {
                    editor = await fillPromptToWeb(effectivePrompt, selectedMode);
                } catch (fillError) {
                    console.error(`[processSinglePrompt] fillPromptToWeb error:`, fillError);
                    safeSendQueueStatus({ groupId, index, status: 'Prompt entry error ❌', percent: 0 });
                    return;
                }

                if (!editor) {
                    safeSendQueueStatus({ groupId, index, status: 'Could not enter prompt ❌', percent: 0 });
                    return;
                }

                await new Promise(r => setTimeout(r, 900));
                const submitButton = getSubmitButtonNearEditor(editor, selectedMode) || findSubmitButton(editor);
                if (false && !submitButton) {
                    safeSendQueueStatus({ groupId, index, status: 'Run button not found ❌', percent: 0 });
                    return;
                }

                let submitted = false;
                let activeEditor = editor;
                const failureIdsBeforeSubmit = getVisibleFlowFailureIds();

                for (let submitAttempt = 0; submitAttempt < 2 && !submitted; submitAttempt++) {
                    if (!isPromptCommitted(activeEditor, effectivePrompt)) {
                        const refillEditor = await fillPromptToWeb(effectivePrompt, selectedMode);
                        if (!refillEditor) {
                            safeSendQueueStatus({ groupId, index, status: 'Could not commit prompt ❌', percent: 0 });
                            return;
                        }
                        activeEditor = refillEditor;
                    }

                    const beforeErrorCount = getVisiblePromptRequiredErrorCount();
                    let activeSubmitButton = getSubmitButtonNearEditor(activeEditor, selectedMode) || findSubmitButton(activeEditor) || submitButton;
                    const runButton = findRunButtonWithoutDebugger(activeEditor) || getElementByXPath(RUN_BUTTON_XPATH);
                    if (runButton && isElementVisible(runButton)) {
                        activeSubmitButton = runButton;
                        console.log('[submit-debug] Using detected run button.', {
                            text: (runButton.textContent || '').trim(),
                            className: runButton.className || '',
                            ariaDisabled: runButton.getAttribute('aria-disabled') || ''
                        });
                    }
                    if (!activeSubmitButton) {
                        const beforeGridSnapshot = getRenderGridSnapshot();
                        const trustedFallbackClicked = await trustedClickRunFallback(null, activeEditor);
                        const keyboardFallbackSent = await submitPromptByKeyboardFallback(activeEditor, null);
                        if (trustedFallbackClicked || keyboardFallbackSent) {
                            const submitResult = await waitForSubmitAcceptance(
                                activeEditor,
                                promptText,
                                beforeErrorCount,
                                beforeGridSnapshot,
                                3200,
                                failureIdsBeforeSubmit,
                                { assumeQueuedOnTimeout: true }
                            );

                            if (submitResult.accepted) {
                                submitted = true;
                                break;
                            }

                            if (submitResult.promptRequiredError && submitAttempt < 1) {
                                safeSendQueueStatus({ groupId, index, status: 'Retrying submit...', percent: 0 });
                                continue;
                            }

                            if (submitResult.flowFailure) {
                                markPromptRenderFailure(groupId, index);
                                return false;
                            }

                            if (submitAttempt < 1) {
                                safeSendQueueStatus({ groupId, index, status: 'Flow did not accept run, retrying...', percent: 0 });
                                await new Promise(r => setTimeout(r, 900));
                                continue;
                            }

                            return false;
                        }
                        safeSendQueueStatus({ groupId, index, status: 'Run button not found ❌', percent: 0 });
                        return;
                    }

                    const beforeGridSnapshot = getRenderGridSnapshot();

                    if (isImageMode(selectedMode)) {
                        console.log("-> Waiting 1000ms after prompt input before submission (IMAGE)...");
                        await new Promise(r => setTimeout(r, 1000));
                    }

                    const btnRect = activeSubmitButton.getBoundingClientRect();
                    const centerX = Math.round(btnRect.left + btnRect.width / 2);
                    const centerY = Math.round(btnRect.top + btnRect.height / 2);
                    let topElementTag = '';
                    let topElementClass = '';
                    try {
                        const topEl = document.elementFromPoint(centerX, centerY);
                        if (topEl) {
                            topElementTag = topEl.tagName || '';
                            topElementClass = topEl.className || '';
                        }
                    } catch (e) { }

                    let pointerEvents = '';
                    try {
                        pointerEvents = getComputedStyle(activeSubmitButton).pointerEvents || '';
                    } catch (e) { }
                    const submitDebug = {
                        tag: activeSubmitButton.tagName,
                        id: activeSubmitButton.id || '',
                        type: activeSubmitButton.getAttribute('type') || '',
                        text: (activeSubmitButton.textContent || '').trim(),
                        ariaLabel: activeSubmitButton.getAttribute('aria-label') || '',
                        className: activeSubmitButton.className || '',
                        disabled: !!activeSubmitButton.disabled,
                        ariaDisabled: activeSubmitButton.getAttribute('aria-disabled') || '',
                        dataState: activeSubmitButton.getAttribute('data-state') || '',
                        pointerEvents,
                        topElementTag,
                        topElementClass,
                        rect: {
                            x: Math.round(btnRect.x),
                            y: Math.round(btnRect.y),
                            w: Math.round(btnRect.width),
                            h: Math.round(btnRect.height)
                        }
                    };
                    console.log("[submit-debug] btn=", submitDebug);
                    console.log("[submit-debug] btn-json=", JSON.stringify(submitDebug));

                    try {
                        const logEvent = (e) => {
                            console.log(`[submit-debug] event ${e.type} isTrusted=${e.isTrusted} defaultPrevented=${e.defaultPrevented}`);
                        };
                        ['pointerdown', 'pointerup', 'mousedown', 'mouseup', 'click'].forEach(type => {
                            activeSubmitButton.addEventListener(type, logEvent, { capture: true, once: true });
                        });
                    } catch (e) { }

                    const clicked = clickSubmitButtonSafely(activeSubmitButton, selectedMode);
                    console.log(`[submit-debug] click result=${clicked}`);

                    const trustedFallbackClicked = await trustedClickRunFallback(activeSubmitButton, activeEditor);
                    await new Promise(r => setTimeout(r, 450));

                    if (isImageMode(selectedMode) && activeEditor) {
                        try {
                            activeEditor.dispatchEvent(new KeyboardEvent('keydown', {
                                key: 'Enter',
                                code: 'Enter',
                                bubbles: true,
                                cancelable: true
                            }));
                            activeEditor.dispatchEvent(new KeyboardEvent('keyup', {
                                key: 'Enter',
                                code: 'Enter',
                                bubbles: true,
                                cancelable: true
                            }));
                            console.log('[submit-debug] Sent Enter to editor as fallback (IMAGE).');
                        } catch (e) { }

                        try {
                            const form = activeSubmitButton.closest('form');
                            if (form) {
                                if (typeof form.requestSubmit === 'function') {
                                    form.requestSubmit(activeSubmitButton);
                                    console.log('[submit-debug] Called form.requestSubmit (IMAGE).');
                                }
                                const submitEvent = new Event('submit', { bubbles: true, cancelable: true });
                                const dispatched = form.dispatchEvent(submitEvent);
                                console.log(`[submit-debug] Dispatched form submit event (IMAGE). ok=${dispatched}`);
                            }
                        } catch (e) { }

                        try {
                            const parentButton = activeSubmitButton.closest('[role="button"], button');
                            if (parentButton && parentButton !== activeSubmitButton) {
                                forceUserLikeClick(parentButton);
                                console.log('[submit-debug] Clicked parent role=button (IMAGE).');
                            }
                        } catch (e) { }
                    }
                    if (!clicked) {
                        safeSendQueueStatus({ groupId, index, status: 'Submit click failed, trying fallback...', percent: 0 });
                    }

                    let submitResult = await waitForSubmitAcceptance(
                        activeEditor,
                        promptText,
                        beforeErrorCount,
                        beforeGridSnapshot,
                        3200,
                        failureIdsBeforeSubmit
                    );

                    if (!submitResult.accepted && !submitResult.flowFailure && !submitResult.promptRequiredError) {
                        safeSendQueueStatus({ groupId, index, status: 'Trying keyboard/React submit fallback...', percent: 0 });

                        const reactFallback = await triggerRunButtonByReactHandler(activeSubmitButton);
                        await new Promise(r => setTimeout(r, 500));
                        const keyboardFallback = await submitPromptByKeyboardFallback(activeEditor, activeSubmitButton);

                        console.log(`[submit-debug] fallback react=${reactFallback} keyboard=${keyboardFallback}`);

                        if (reactFallback || keyboardFallback || !clicked) {
                            submitResult = await waitForSubmitAcceptance(
                                activeEditor,
                                promptText,
                                beforeErrorCount,
                                beforeGridSnapshot,
                                5200,
                                failureIdsBeforeSubmit,
                                { assumeQueuedOnTimeout: !!(reactFallback || keyboardFallback || trustedFallbackClicked) }
                            );
                        }
                    }

                    if (!submitResult.accepted && !submitResult.flowFailure && !submitResult.promptRequiredError) {
                        hideManualRunHint();
                        console.log('[submit-debug] manual Run prompt disabled; submit was not accepted.');
                    }

                    if (submitResult.accepted) {
                        submitted = true;
                        break;
                    }

                    if (submitResult.flowFailure) {
                        markPromptRenderFailure(groupId, index);
                        return false;
                    }

                    if (submitResult.promptRequiredError && submitAttempt < 1) {
                        safeSendQueueStatus({ groupId, index, status: 'Resubmitting… 🔁', percent: 0 });
                        continue;
                    }

                    if (submitAttempt < 1) {
                        safeSendQueueStatus({ groupId, index, status: 'Flow did not accept run, retrying...', percent: 0 });
                        await new Promise(r => setTimeout(r, 900));
                        continue;
                    }

                    return false;
                }

                if (!submitted) {
                    safeSendQueueStatus({ groupId, index, status: 'Submit failed ❌', percent: 0 });
                    return;
                }

                promptProcessingInProgress = false;
                safeSendQueueStatus({ groupId, index, status: 'Rendering… ⏳', percent: 1 });

                const snapshotKey = `${String(groupId)}:${index}:snapshot`;
                const existingTileIds = new Set(
                    Array.from(document.querySelectorAll('[data-tile-id]'))
                        .map(el => el.getAttribute('data-tile-id'))
                        .filter(Boolean)
                );
                monitorVideoProgress._tileSnapshot = monitorVideoProgress._tileSnapshot || new Map();
                monitorVideoProgress._tileSnapshot.set(snapshotKey, existingTileIds);

                if (!waitForCompletion) {
                    monitorVideoProgress(index, promptText, groupId, selectedMode, deferDownload, failureIdsBeforeSubmit).catch(() => { });
                    return;
                }

                const done = await monitorVideoProgress(index, promptText, groupId, selectedMode, deferDownload, failureIdsBeforeSubmit);

                if (!done) {
                    safeSendQueueStatus({ groupId, index, status: 'Flow reported error, retrying...', percent: 0 });
                    return false;
                }
                return true;
            } finally {
                promptProcessingInProgress = false;
            }
        };

        const runPromptWithRetries = async (index, waitForCompletion = true, deferDownload = false) => {
            for (let attempt = 0; attempt <= safeMaxRetries; attempt++) {
                if (controller.stopped) return false;

                if (attempt > 0) {
                    resetPromptDownloadLock(groupId, index);
                    clearRenderCardOwners();
                    const delayMs = getRandomDelayMs(minDelay, maxDelay);
                    safeSendQueueStatus({ groupId, index, status: `Retrying ${attempt}/${safeMaxRetries} in ${Math.round(delayMs / 1000)}s...`, percent: 0 });
                    await new Promise(r => setTimeout(r, delayMs));
                }

                // Only a new explicit render failure from this attempt may trigger retry.
                consumePromptRenderFailure(groupId, index);
                const failureIdsBeforeAttempt = getVisibleFlowFailureIds();
                const ok = await processSinglePrompt(index, waitForCompletion, deferDownload);
                if (ok) return true;

                const shouldRetry = consumePromptRenderFailure(groupId, index);
                if (!shouldRetry) {
                    safeSendQueueStatus({ groupId, index, status: 'Skipping retry — no failure card found.', percent: 0 });
                    return true;
                }

                if (attempt >= safeMaxRetries) break;

                safeSendQueueStatus({ groupId, index, status: `Render failed, retrying ${attempt + 1}/${safeMaxRetries}...`, percent: 0 });
                await new Promise(r => setTimeout(r, 1800));

                const clickedRetry = await clickFailureRetryButton(failureIdsBeforeAttempt);
                if (clickedRetry && waitForCompletion) {
                    safeSendQueueStatus({ groupId, index, status: `Retry clicked, waiting for render...`, percent: 1 });
                    const retryDone = await monitorVideoProgress(index, String(prompts[index] || ''), groupId, selectedMode, deferDownload, failureIdsBeforeAttempt);
                    if (retryDone) return true;
                }
            }

            safeSendQueueStatus({ groupId, index, status: `Exceeded retries (${safeMaxRetries})`, percent: 0 });
            return false;
        };

        const startIndex = Math.max(0, parseInt(request.startFromIndex || 0, 10));

        if (safeConcurrentCount <= 1) {
            for (let index = startIndex; index < prompts.length; index++) {
                if (controller.stopped) break;

                // Sync current index to session in storage
                try {
                    const res = await chrome.storage.local.get(['veo_running_session']);
                    if (res?.veo_running_session && res.veo_running_session.groupId === groupKey) {
                        res.veo_running_session.currentIndex = index;
                        chrome.storage.local.set({ veo_running_session: res.veo_running_session }).catch(() => {});
                    }
                } catch (e) {}

                await runPromptWithRetries(index, true);
                clearRenderCardOwners();

                // Mark prompt completed in storage
                try {
                    const res = await chrome.storage.local.get(['veo_running_session']);
                    if (res?.veo_running_session && res.veo_running_session.groupId === groupKey) {
                        res.veo_running_session.currentIndex = index + 1;
                        res.veo_running_session.itemStatuses = res.veo_running_session.itemStatuses || {};
                        res.veo_running_session.itemStatuses[index] = { status: 'Done ✅', percent: 100 };
                        if (index >= prompts.length - 1) {
                            res.veo_running_session.status = 'completed';
                        }
                        chrome.storage.local.set({ veo_running_session: res.veo_running_session }).catch(() => {});
                    }
                } catch (e) {}

                if (index < prompts.length - 1 && !controller.stopped) {
                    const delayMs = getRandomDelayMs(minDelay, maxDelay);
                    await new Promise(r => setTimeout(r, delayMs));
                }
            }
        } else {
            const initialBatchStart = Math.floor(startIndex / safeConcurrentCount) * safeConcurrentCount;
            for (let batchStart = initialBatchStart; batchStart < prompts.length; batchStart += safeConcurrentCount) {
                if (controller.stopped) break;

                const batchEnd = Math.min(batchStart + safeConcurrentCount, prompts.length);
                const batchIndices = [];
                for (let i = batchStart; i < batchEnd; i++) {
                    if (i >= startIndex) batchIndices.push(i);
                }
                if (batchIndices.length === 0) continue;

                const downloadBatchResults = async () => {
                    const failedIndices = [];
                    for (let i = 0; i < batchIndices.length; i++) {
                        if (controller.stopped) break;
                        const ok = await handlePromptCompletionDownload(batchIndices[i], groupId, selectedMode);
                        if (ok === false) failedIndices.push(batchIndices[i]);
                        // Wait 1.5s between prompts to prevent collision
                        if (i < batchIndices.length - 1 && !controller.stopped) {
                            await new Promise(r => setTimeout(r, 1500));
                        }
                    }
                    return failedIndices;
                };

                for (let i = 0; i < batchIndices.length; i++) {
                    const index = batchIndices[i];
                    if (controller.stopped) break;
                    await processSinglePrompt(index, false, true);
                    if (i < batchIndices.length - 1 && !controller.stopped) {
                        await new Promise(r => setTimeout(r, 5000));
                    }
                }

                const BATCH_HARD_TIMEOUT = 15 * 60 * 1000;
                const batchStartTime = Date.now();

                await new Promise((resolve) => {
                    const checkInterval = setInterval(() => {
                        const monitors = monitorVideoProgress._groupCounters;
                        const activeCount = monitors ? (monitors.get(groupKey) || 0) : 0;
                        if (activeCount === 0 || Date.now() - batchStartTime > BATCH_HARD_TIMEOUT) {
                            clearInterval(checkInterval);
                            resolve();
                        }
                    }, 1000);
                });

                const failedBatchIndices = await downloadBatchResults();
                for (const failedIndex of failedBatchIndices) {
                    if (controller.stopped) break;
                    await runPromptWithRetries(failedIndex, true);
                    await new Promise(r => setTimeout(r, 1500));
                }

                // Clear owner after batch completion
                clearRenderCardOwners();

    // Mark all batch prompts as Done
                for (const promptIndex of batchIndices) {
                    if (failedBatchIndices.includes(promptIndex)) continue;
                    safeSendQueueStatus({ groupId, index: promptIndex, status: 'Done ✅', percent: 100 });
                }

                const hasNextBatch = batchEnd < prompts.length && !controller.stopped;
                if (hasNextBatch) {
                    const delayMs = getRandomDelayMs(minDelay, maxDelay);
                    await new Promise(r => setTimeout(r, delayMs));
                }
            }
        }
    } catch (error) {
        console.error('runAutomation error:', error);
        safeSendQueueStatus({ groupId: groupKey, index: 0, status: 'Automation error ❌', percent: 0 });
    } finally {
        runningGroups.delete(groupKey);
    }
}

function findGeminiPromptEditor() {
    const selectors = [
        'rich-textarea .ql-editor[contenteditable="true"][aria-label*="prompt" i]',
        'rich-textarea .ql-editor[contenteditable="true"][aria-label*="cau lenh" i]',
        'rich-textarea .ql-editor[contenteditable="true"][aria-label*="gemini" i]',
        'rich-textarea .ql-editor.textarea.new-input-ui[contenteditable="true"]',
        '.ql-editor.textarea.new-input-ui[contenteditable="true"][data-placeholder*="Enter a prompt for Gemini"]',
        '.ql-editor.textarea.new-input-ui[contenteditable="true"][data-placeholder*="Enter a prompt for Gemini"]',
        'div.ql-editor[contenteditable="true"][role="textbox"]'
    ];

    for (const selector of selectors) {
        const element = document.querySelector(selector);
        if (element && isElementVisible(element)) {
            return element;
        }
    }

    const fallbackEditors = Array.from(document.querySelectorAll('rich-textarea .ql-editor[contenteditable="true"], .ql-editor[contenteditable="true"][role="textbox"]'))
        .filter(el => isElementVisible(el));

    return fallbackEditors[0] || null;
}

function normalizeUiText(value) {
    return String(value || '')
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/\s+/g, ' ')
        .trim()
        .toLowerCase();
}

function normalizePromptText(value) {
    return String(value || '').toLowerCase().replace(/\s+/g, ' ').trim();
}

function buildPromptTokens(promptText) {
    const normalized = normalizePromptText(promptText);
    if (!normalized) return [];

    if (normalized.length <= 80) {
        return [normalized];
    }

    const head = normalized.substring(0, 60);
    const midStart = Math.max(0, Math.floor(normalized.length / 2) - 30);
    const mid = normalized.substring(midStart, midStart + 60);
    const tail = normalized.substring(Math.max(0, normalized.length - 60));

    return [head, mid, tail].filter(Boolean);
}

function editorContainsPrompt(editor, promptText) {
    if (!editor) return false;

    const current = normalizePromptText(editor.innerText || editor.textContent || '');
    const tokens = buildPromptTokens(promptText);
    if (tokens.length === 0) return false;

    return tokens.every(token => current.includes(token));
}

function clearGeminiEditor(editor) {
    if (!editor) return;

    editor.focus();
    forceUserLikeClick(editor);

    const selection = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(editor);
    selection.removeAllRanges();
    selection.addRange(range);

    try {
        document.execCommand('delete', false, null);
    } catch (e) {
        editor.innerHTML = '<p><br></p>';
    }
}

async function setGeminiPrompt(editor, promptText) {
    if (!editor) return false;

    const rawText = String(promptText || '');
    const safeText = rawText.trim();
    if (!safeText) return false;

    const wait = (ms) => new Promise(resolve => setTimeout(resolve, ms));

    clearGeminiEditor(editor);
    await wait(80);

    try {
        const dataTransfer = new DataTransfer();
        dataTransfer.setData('text/plain', rawText);
        editor.dispatchEvent(new ClipboardEvent('paste', {
            clipboardData: dataTransfer,
            bubbles: true,
            cancelable: true
        }));
    } catch (e) { }

    try {
        editor.dispatchEvent(new Event('input', { bubbles: true }));
        editor.dispatchEvent(new Event('change', { bubbles: true }));
    } catch (e) { }

    await wait(160);
    if (editorContainsPrompt(editor, rawText)) {
        return true;
    }

    clearGeminiEditor(editor);
    await wait(80);

    try {
        document.execCommand('insertText', false, rawText);
    } catch (e) {
        editor.textContent = rawText;
    }

    try {
        editor.dispatchEvent(new InputEvent('input', {
            bubbles: true,
            cancelable: true,
            inputType: 'insertText',
            data: rawText
        }));
    } catch (e) {
        editor.dispatchEvent(new Event('input', { bubbles: true }));
    }

    editor.dispatchEvent(new Event('change', { bubbles: true }));
    await wait(160);

    if (editorContainsPrompt(editor, rawText)) {
        return true;
    }

    // Final fallback for newer Gemini editors: set HTML paragraph and trigger input pipeline.
    try {
        const safeHtml = rawText
            .split('\n')
            .map(line => `<p>${line.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;') || '<br>'}</p>`)
            .join('');
        editor.innerHTML = safeHtml || '<p><br></p>';
        editor.dispatchEvent(new Event('input', { bubbles: true }));
        editor.dispatchEvent(new Event('change', { bubbles: true }));
    } catch (e) { }

    await wait(180);

    return editorContainsPrompt(editor, rawText);
}

function setFilesViaGeminiDropzone(files) {
    if (!Array.isArray(files) || files.length === 0) return false;

    const dropzones = queryAllElementsDeep('[xapfileselectordropzone], .text-input-field[xapfileselectordropzone]');
    const dropzone = dropzones.find(el => el && isElementVisible(el)) || dropzones[0] || null;
    if (!dropzone) return false;

    try {
        const transfer = new DataTransfer();
        files.forEach(file => {
            if (file instanceof File) transfer.items.add(file);
        });
        if (transfer.files.length === 0) return false;

        const dispatchWithTransfer = (target, eventType) => {
            let event = null;
            try {
                event = new DragEvent(eventType, {
                    bubbles: true,
                    cancelable: true,
                    composed: true,
                    dataTransfer: transfer
                });
            } catch (e) {
                event = new Event(eventType, { bubbles: true, cancelable: true, composed: true });
            }

            try {
                if (!('dataTransfer' in event) || !event.dataTransfer) {
                    Object.defineProperty(event, 'dataTransfer', {
                        configurable: true,
                        enumerable: true,
                        value: transfer
                    });
                }
            } catch (e) { }

            target.dispatchEvent(event);
        };

        ['dragenter', 'dragover', 'drop'].forEach(eventType => dispatchWithTransfer(dropzone, eventType));
        return true;
    } catch (error) {
        return false;
    }
}

function setFilesViaPasteToComposer(files) {
    if (!Array.isArray(files) || files.length === 0) return false;

    const editor = findGeminiPromptEditor();
    const target = editor || document.querySelector('input-area-v2') || document.body;
    if (!target) return false;

    try {
        const transfer = new DataTransfer();
        files.forEach(file => {
            if (file instanceof File) transfer.items.add(file);
        });
        if (transfer.files.length === 0) return false;

        let pasteEvent = null;
        try {
            pasteEvent = new ClipboardEvent('paste', {
                bubbles: true,
                cancelable: true,
                composed: true,
                clipboardData: transfer
            });
        } catch (e) {
            pasteEvent = new Event('paste', { bubbles: true, cancelable: true, composed: true });
        }

        try {
            if (!('clipboardData' in pasteEvent) || !pasteEvent.clipboardData) {
                Object.defineProperty(pasteEvent, 'clipboardData', {
                    configurable: true,
                    enumerable: true,
                    value: transfer
                });
            }
        } catch (e) { }

        target.dispatchEvent(pasteEvent);
        return true;
    } catch (error) {
        return false;
    }
}

function hasGeminiAttachmentRendered(expectedFiles = []) {
    const names = (Array.isArray(expectedFiles) ? expectedFiles : [])
        .map(file => normalizeUiText(file?.name || ''))
        .filter(Boolean);

    const attachmentSelectors = [
        'uploaded-file-chip',
        '[data-test-id*="upload"]',
        '[data-test-id*="file"]',
        '.upload-chip',
        '.attachment-chip',
        '.file-chip',
        'mat-chip',
        'button[aria-label*="remove" i][aria-label*="file" i]'
    ];

    const attachmentNodes = queryAllElementsDeep(attachmentSelectors.join(','));
    if (attachmentNodes.length === 0) return false;

    if (names.length === 0) return true;

    const textBlob = normalizeUiText(attachmentNodes.map(node => node.textContent || '').join(' '));
    return names.some(name => name && textBlob.includes(name));
}

function findGeminiSubmitButton() {
    const primaryXPath = '/html/body/chat-app/main/side-navigation-v2/mat-sidenav-container/mat-sidenav-content/div/div[2]/chat-window/div/input-container/fieldset/input-area-v2/div/div/div[3]/div[2]/div[2]/button';
    const direct = getElementByXPath(primaryXPath);
    if (direct && isElementVisible(direct) && !direct.disabled && direct.getAttribute('aria-disabled') !== 'true') {
        return direct;
    }

    const scopedButtons = Array.from(document.querySelectorAll('input-area-v2 button, chat-window button, input-container button'))
        .filter(btn => isElementVisible(btn) && !btn.disabled && btn.getAttribute('aria-disabled') !== 'true');

    const semantic = scopedButtons.find(btn => {
        const aria = normalizeUiText(btn.getAttribute('aria-label') || '');
        const text = normalizeUiText(btn.textContent || '');
        return aria.includes('send')
            || aria.includes('run')
            || aria.includes('gui')
            || aria.includes('goi tin nhan')
            || text.includes('send')
            || text.includes('run')
            || text.includes('gui');
    });
    if (semantic) return semantic;

    return scopedButtons[scopedButtons.length - 1] || null;
}

function findGeminiUploadTriggerButton() {
    const byKnownXPath = getElementByXPath(GEMINI_PLUS_BUTTON_XPATH);
    if (byKnownXPath && isElementVisible(byKnownXPath) && !byKnownXPath.disabled && byKnownXPath.getAttribute('aria-disabled') !== 'true') {
        return byKnownXPath;
    }

    const isUnsafeFilePickerTrigger = (el) => {
        if (!el) return true;
        if (el.hasAttribute('xapfileselectortrigger')) return true;
        const className = String(el.className || '').toLowerCase();
        if (className.includes('hidden-local-upload-button') || className.includes('hidden-local-file-upload-button')) return true;
        const dataTestId = String(el.getAttribute('data-test-id') || '').toLowerCase();
        if (dataTestId.includes('hidden-local-file-upload-button') || dataTestId.includes('hidden-local-image-upload-button')) return true;
        const ariaHidden = String(el.getAttribute('aria-hidden') || '').toLowerCase();
        if (ariaHidden === 'true') return true;
        return false;
    };

    // First, look for button in images-files-uploader component (most specific location)
    const uploadComponent = document.querySelector('images-files-uploader');
    if (uploadComponent) {
        const uploadBtn = Array.from(uploadComponent.querySelectorAll('button'))
            .find(btn => !btn.disabled && btn.getAttribute('aria-disabled') !== 'true' && !isUnsafeFilePickerTrigger(btn));
        if (uploadBtn) {
            return uploadBtn;
        }
    }

    const candidates = Array.from(document.querySelectorAll('input-area-v2 button, chat-window button, button, [role="button"]'))
        .filter(el => isElementVisible(el) && !el.disabled && el.getAttribute('aria-disabled') !== 'true' && !isUnsafeFilePickerTrigger(el));

    // Look for explicit upload/attach buttons by aria-label, title, or text
    const semantic = candidates.find(el => {
        const aria = normalizeUiText(el.getAttribute('aria-label') || '');
        const title = normalizeUiText(el.getAttribute('title') || '');
        const text = normalizeUiText(el.textContent || '');
        return aria.includes('upload')
            || aria.includes('add file')
            || aria.includes('attach')
            || aria.includes('file')
            || aria.includes('tai tep')
            || aria.includes('tai file')
            || aria.includes('mo trinh don tai')
            || title.includes('upload')
            || title.includes('attach')
            || title.includes('tai tep')
            || text.includes('upload')
            || text.includes('add files')
            || text.includes('attach')
            || text.includes('tai tep')
            || text.includes('tai len');
    });

    if (semantic) return semantic;

    // Look for icon buttons with google-symbols
    const withIcon = candidates.find(el => {
        const icon = el.querySelector('i.google-symbols, .google-symbols');
        if (!icon) return false;
        const iconText = (icon?.textContent || '').trim().toLowerCase();
        return iconText === 'add' || iconText === 'attach_file' || iconText === 'upload' || iconText === 'add_circle';
    });

    if (withIcon) return withIcon;

    // Look for buttons with specific SVG icons or aria-label patterns
    const byIcon = candidates.find(el => {
        const svg = el.querySelector('svg');
        const aria = normalizeUiText(el.getAttribute('aria-label') || '');
        // Common patterns for attachment buttons
        if (aria.includes('attach') || aria.includes('file') || aria.includes('image') || aria.includes('tai tep')) return true;
        // Icon buttons without text (pure icon buttons in input area)
        if (svg && !el.textContent.trim()) return true;
        return false;
    });

    if (byIcon) return byIcon;

    // Fallback: in Gemini, the first button in input-area-v2 is often the attachment button
    const inputArea = document.querySelector('input-area-v2');
    if (inputArea) {
        const areaButtons = Array.from(inputArea.querySelectorAll('button, [role="button"]'))
            .filter(el => isElementVisible(el) && !el.disabled && el.getAttribute('aria-disabled') !== 'true' && !isUnsafeFilePickerTrigger(el));
        // Usually first or second button is attachment
        if (areaButtons.length > 0) {
            return areaButtons[0];
        }
    }

    return null;
}

function findGeminiFileInputForUpload() {
    // File inputs can be hidden or inside shadow roots, so search deeply and avoid visibility checks.
    const inputs = queryAllElementsDeep('input[type="file"]')
        .filter(input => !input.disabled);

    if (inputs.length === 0) return null;

    // Prefer input that accepts audio/video
    const audioPreferred = inputs.find(input => {
        const accept = (input.getAttribute('accept') || '').toLowerCase();
        return accept.includes('audio') || accept.includes('video') || accept.includes('*/*');
    });

    // If no audio preference, return the most recently added input (last in DOM)
    return audioPreferred || inputs[inputs.length - 1] || null;
}

async function injectGeminiUploadedFiles(uploadedFiles) {
    const normalizedFiles = normalizeIncomingFiles(uploadedFiles || []);
    if (!Array.isArray(normalizedFiles) || normalizedFiles.length === 0) {
        return { ok: true, uploaded: false };
    }

    const uploadFiles = normalizedFiles.filter(file => {
        const type = String(file?.type || '').toLowerCase();
        return type.startsWith('audio/') || type.startsWith('video/');
    });

    if (uploadFiles.length === 0) {
        return { ok: false, uploaded: false, message: 'No valid audio/video file to upload' };
    }

    // If attachment is already present in Gemini UI, skip all further upload attempts.
    if (hasGeminiAttachmentRendered(uploadFiles)) {
        return { ok: true, uploaded: true };
    }

    // Step 1: Click the "+" uploader button to open upload menu (UI alignment with Gemini flow).
    // We only open the menu; we still avoid native file picker click to prevent OS dialog blocking.
    const menuOpened = await openGeminiUploadMenuSafely();
    if (menuOpened) {
        for (let i = 0; i < 10; i++) {
            const mountedInput = findGeminiFileInputForUpload();
            if (mountedInput) break;
            await new Promise(r => setTimeout(r, 120));
        }
    }

    // First attempt to find file input (it may be hidden)
    let fileInput = findGeminiFileInputForUpload();

    if (fileInput) {
        const directSetOk = setFilesToInput(fileInput, uploadFiles);
        if (directSetOk) {
            await new Promise(r => setTimeout(r, 1200));
            if (hasGeminiAttachmentRendered(uploadFiles)) {
                return { ok: true, uploaded: true };
            }
        }
    }

    const earlyDropzoneOk = setFilesViaGeminiDropzone(uploadFiles);
    if (earlyDropzoneOk) {
        await new Promise(r => setTimeout(r, 1200));
        if (hasGeminiAttachmentRendered(uploadFiles)) {
            return { ok: true, uploaded: true };
        }
    }

    const earlyPasteOk = setFilesViaPasteToComposer(uploadFiles);
    if (earlyPasteOk) {
        await new Promise(r => setTimeout(r, 1200));
        if (hasGeminiAttachmentRendered(uploadFiles)) {
            return { ok: true, uploaded: true };
        }
    }

    // Never click upload trigger here because it can open native File Explorer dialog
    // which cannot be auto-closed by extension script. Retry direct discovery only.
    // Retry a few times only; avoid excessive repeated reads/checks.
    for (let attempt = 0; attempt < 8; attempt++) {
        fileInput = findGeminiFileInputForUpload();
        if (fileInput) {
            break;
        }

        if (attempt === 3) {
            await openGeminiUploadMenuSafely();
        }

        const retryDropzoneOk = setFilesViaGeminiDropzone(uploadFiles);
        if (retryDropzoneOk) {
            await new Promise(r => setTimeout(r, 1200));
            if (hasGeminiAttachmentRendered(uploadFiles)) {
                return { ok: true, uploaded: true };
            }
        }

        const retryPasteOk = setFilesViaPasteToComposer(uploadFiles);
        if (retryPasteOk) {
            await new Promise(r => setTimeout(r, 1200));
            if (hasGeminiAttachmentRendered(uploadFiles)) {
                return { ok: true, uploaded: true };
            }
        }
        await new Promise(r => setTimeout(r, 180));
    }

    if (!fileInput) {
        const dropzoneOk = setFilesViaGeminiDropzone(uploadFiles);
        if (dropzoneOk) {
            await new Promise(r => setTimeout(r, 1200));
            return { ok: true, uploaded: true };
        }
        return { ok: false, uploaded: false, message: 'Upload input not found in Gemini (timeout)' };
    }

    // Try to set files to input
    const setOk = setFilesToInput(fileInput, uploadFiles);
    if (!setOk) {
        await new Promise(r => setTimeout(r, 350));
        fileInput = findGeminiFileInputForUpload();
        if (fileInput) {
            const retryOk = setFilesToInput(fileInput, uploadFiles);
            if (!retryOk) {
                const dropzoneOk = setFilesViaGeminiDropzone(uploadFiles);
                if (dropzoneOk) {
                    await new Promise(r => setTimeout(r, 1200));
                    if (hasGeminiAttachmentRendered(uploadFiles)) {
                        return { ok: true, uploaded: true };
                    }
                }

                const pasteOk = setFilesViaPasteToComposer(uploadFiles);
                if (pasteOk) {
                    await new Promise(r => setTimeout(r, 1200));
                    if (hasGeminiAttachmentRendered(uploadFiles)) {
                        return { ok: true, uploaded: true };
                    }
                }
        return { ok: false, uploaded: false, message: 'Failed to attach file to Gemini upload input (retry failed)' };
            }
            await new Promise(r => setTimeout(r, 1200));
            if (hasGeminiAttachmentRendered(uploadFiles)) {
                return { ok: true, uploaded: true };
            }
        } else {
            const dropzoneOk = setFilesViaGeminiDropzone(uploadFiles);
            if (dropzoneOk) {
                await new Promise(r => setTimeout(r, 1200));
                if (hasGeminiAttachmentRendered(uploadFiles)) {
                    return { ok: true, uploaded: true };
                }
            }

            const pasteOk = setFilesViaPasteToComposer(uploadFiles);
            if (pasteOk) {
                await new Promise(r => setTimeout(r, 1200));
                if (hasGeminiAttachmentRendered(uploadFiles)) {
                    return { ok: true, uploaded: true };
                }
            }
            return { ok: false, uploaded: false, message: 'Upload input not found in Gemini' };
        }
    }

    // Wait for Gemini to process the attachment
    await new Promise(r => setTimeout(r, 1200));
    if (hasGeminiAttachmentRendered(uploadFiles)) {
        return { ok: true, uploaded: true };
    }
        return { ok: false, uploaded: false, message: 'Attachment attempted but Gemini did not recognize file.' };
}

function isGeminiStatusNoise(text) {
    const normalized = String(text || '').toLowerCase();
    return /enter a prompt for gemini|defining the parameters|initiating the analysis|answer now|gemini said|expand menu|thinking|processing|parameter/i.test(normalized);
}

function scoreGeminiResponseText(text) {
    const normalized = String(text || '').trim();
    if (!normalized) return -1;

    let score = normalized.length;
    if (/"scene_number"|"timecode"|"character"|"scene_setting"/i.test(normalized)) score += 1200;
    if (/^\s*\[/.test(normalized) || /^\s*\{/.test(normalized)) score += 400;
    if (/^\s*```/.test(normalized)) score -= 100;
    if (isGeminiStatusNoise(normalized)) score -= 2000;
    return score;
}

function getLatestGeminiResponseText() {
    const host = document.querySelector('chat-window') || document.querySelector('chat-app') || document.body;
    if (!host) return '';

    // Find ALL model response containers (in order they appear)
    const selectors = [
        'div[data-message-author-role="model"]',
        'model-response',
        '.model-response',
        '.response-content'
    ];

    const allContainers = Array.from(host.querySelectorAll(selectors.join(',')));

    if (allContainers.length === 0) return '';

    // Get ONLY the LAST (most recent) container
    const lastContainer = allContainers[allContainers.length - 1];

    if (!lastContainer) return '';

    // Scroll last container to ensure all content is rendered
    try {
        if (lastContainer.scrollHeight > lastContainer.clientHeight) {
            lastContainer.scrollTop = lastContainer.scrollHeight;
        }
    } catch (e) {
        // Scrolling failed, continue anyway
    }

    // Try to extract text from the latest container
    let result = '';

    // Try innerText first (respects display: none)
    if (isElementVisible(lastContainer)) {
        result = (lastContainer.innerText || '').trim();
    }

    // Fallback to textContent if innerText is empty
    if (!result) {
        result = (lastContainer.textContent || '').trim();
    }

    // Clean up the result
    result = result
        .split('\n')
        .filter(line => line.trim().length > 0)
        .join('\n')
        .slice(0, 50000); // Safety limit

    console.log(`[getLatestGeminiResponseText] Latest container extracted ${result.length} chars (${(result.match(/{/g) || []).length} JSON objects) from ${allContainers.length} total responses`);
    return result;
}

function pushGeminiPreviewToExtension(previewText, isFinal = false, runToken = '') {
    const safeText = String(previewText || '').trim();
    if (!safeText) return;

    try {
        chrome.storage.local.set({ geminiPreviewContent: safeText }).catch(() => { });
    } catch (e) { }

    try {
        chrome.runtime?.sendMessage({
            action: 'GEMINI_PREVIEW_UPDATE',
            previewText: safeText,
            isFinal,
            runToken: String(runToken || '')
        }).catch(() => { });
    } catch (e) { }
}

function isGeminiGeneratingNow() {
    const stopSpanXPath = '/html/body/chat-app/main/side-navigation-v2/mat-sidenav-container/mat-sidenav-content/div/div[2]/chat-window/div/input-container/fieldset/input-area-v2/div/div/div[3]/div[2]/div[2]/button/span[3]';
    const stopSpan = getElementByXPath(stopSpanXPath);
    if (stopSpan && isElementVisible(stopSpan)) {
        return true;
    }

    const candidateButtons = Array.from(document.querySelectorAll('input-area-v2 button, chat-window button, button.send-button, button[aria-label]'));
    const stopButton = candidateButtons.find(btn => {
        if (!btn || !isElementVisible(btn)) return false;
        const aria = normalizeUiText(btn.getAttribute('aria-label') || '');
        const text = normalizeUiText(btn.textContent || '');
        return aria.includes('ngung tao cau tra loi')
            || aria.includes('dung tao cau tra loi')
            || aria.includes('stop generating')
            || aria.includes('stop response')
            || text.includes('stop')
            || text.includes('ngung');
    });

    return Boolean(stopButton);
}

async function monitorGeminiResponseAndPushPreview(runToken = '') {
    let lastText = '';
    let stableCount = 0;
    let sawGenerating = false;
    let maxLengthSeen = 0;

    for (let attempt = 0; attempt < 300; attempt++) {
        await new Promise(r => setTimeout(r, 1200));

        const generating = isGeminiGeneratingNow();
        if (generating) {
            sawGenerating = true;
        }

        const currentText = getLatestGeminiResponseText();
        if (!currentText) continue;

        // Track if we're seeing content growth (streaming/generating)
        if (currentText.length > maxLengthSeen) {
            maxLengthSeen = currentText.length;
            stableCount = 0; // Reset stability counter if new content arrived
            console.log(`[Monitor] Content growing: ${currentText.length} chars (${(currentText.match(/{/g) || []).length} JSON objects)`);
        } else if (currentText === lastText) {
            stableCount += 1;
        } else {
            lastText = currentText;
            stableCount = 0;
        }

        lastText = currentText;

        // Only finalize when Gemini is no longer generating.
        if (generating) {
            continue;
        }

        // If we positively detected generating before, require only short stabilization after it stops.
        if (sawGenerating && stableCount >= 3 && !isGeminiStatusNoise(currentText)) {
            console.log(`[Monitor] Generation complete. Stabilized after ${stableCount} checks. Pushing ${currentText.length} chars with ${(currentText.match(/{/g) || []).length} JSON objects`);
            pushGeminiPreviewToExtension(currentText, true, runToken);
            return true;
        }

        // Fallback path when generation indicator cannot be detected in this UI variant.
        if (!sawGenerating && stableCount >= 12 && !isGeminiStatusNoise(currentText)) {
            console.log(`[Monitor] No generator detected, but stabilized after ${stableCount} checks. Pushing ${currentText.length} chars with ${(currentText.match(/{/g) || []).length} JSON objects`);
            pushGeminiPreviewToExtension(currentText, true, runToken);
            return true;
        }
    }

    if (lastText) {
        console.log(`[Monitor] Timeout reached. Pushing final ${lastText.length} chars with ${(lastText.match(/{/g) || []).length} JSON objects`);
        pushGeminiPreviewToExtension(lastText, true, runToken);
        return true;
    }

    console.error(`[Monitor] No content found after timeout`);
    return false;
}

async function autoFillGeminiPromptAndSubmit(promptText, uploadedFiles = [], runToken = '') {
    const safePrompt = String(promptText || '').trim();
    if (!safePrompt) {
        console.error('[autoFill] Prompt is empty');
        return { ok: false, message: 'Prompt is empty' };
    }

    let uploadStatus = { ok: true, uploaded: false, message: '' };
    if (Array.isArray(uploadedFiles) && uploadedFiles.length > 0) {
        console.log(`[autoFill] Uploading ${uploadedFiles.length} file(s)...`);
        uploadStatus = await injectGeminiUploadedFiles(uploadedFiles);
        if (!uploadStatus.ok) {
            console.error('[autoFill] Upload failed:', uploadStatus.message);
            return { ok: false, message: uploadStatus.message || 'Failed to upload audio file to Gemini' };
        }
        console.log('[autoFill] Upload successful');
    }

    let editor = null;
    for (let attempt = 0; attempt < 20; attempt++) {
        editor = findGeminiPromptEditor();
        if (editor) {
            console.log(`[autoFill] Found editor at attempt ${attempt + 1}`);
            break;
        }
        await new Promise(r => setTimeout(r, 350));
    }

    if (!editor) {
        console.error('[autoFill] Editor not found after 20 attempts (7 seconds)');
        return { ok: false, message: 'Gemini prompt editor not found after 7 seconds' };
    }

    const filled = await setGeminiPrompt(editor, safePrompt);
    if (!filled) {
        console.error('[autoFill] Failed to fill prompt (setGeminiPrompt returned false)');
        return { ok: false, message: 'Failed to paste complete prompt into Gemini editor' };
    }
    console.log('[autoFill] Prompt filled successfully');

    await new Promise(r => setTimeout(r, 260));

    let submitButton = null;
    for (let attempt = 0; attempt < 16; attempt++) {
        submitButton = findGeminiSubmitButton();
        if (submitButton) {
            console.log(`[autoFill] Found submit button at attempt ${attempt + 1}`);
            break;
        }
        await new Promise(r => setTimeout(r, 300));
    }

    if (!submitButton) {
        console.error('[autoFill] Submit button not found after 16 attempts (4.8 seconds)');
        return { ok: false, message: 'Gemini submit button not found after 4.8 seconds' };
    }

    console.log('[autoFill] Clicking submit button...');
    forceUserLikeClick(submitButton);
    monitorGeminiResponseAndPushPreview(runToken).catch(err => {
        console.error('[autoFill] Preview monitoring error:', err?.message);
    });

    const msg = uploadStatus.uploaded
        ? 'Uploaded audio, pasted prompt, and initiated Gemini'
        : 'Pasted prompt and initiated Gemini';
    console.log('[autoFill] Success:', msg);
    return { ok: true, message: msg };
}

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (!request || !request.action) {
        return;
    }

    if (request.action === 'PING_CONTENT_SCRIPT') {
        sendResponse({ ok: true });
        return;
    }

    if (request.action === 'stop_automation' && request.groupId) {
        const running = runningGroups.get(String(request.groupId));
        if (running) {
            running.stopped = true;
        }
        chrome.storage.local.get(['veo_running_session'], (res) => {
            if (res?.veo_running_session && res.veo_running_session.groupId === request.groupId) {
                res.veo_running_session.status = 'stopped';
                chrome.storage.local.set({ veo_running_session: res.veo_running_session }).catch(() => {});
            }
        });
        sendResponse({ ok: true });
        return;
    }

    if (request.action === 'AUTO_FILL_GEMINI_PROMPT') {
        (async () => {
            const result = await autoFillGeminiPromptAndSubmit(
                request.promptText || '',
                Array.isArray(request.uploadedFiles) ? request.uploadedFiles : [],
                String(request.runToken || '')
            );
            sendResponse(result);
        })();
        return true;
    }

    if (request.action === 'run_automation') {
        sendResponse({ ok: true, received: true });
        runAutomation(request);
    }
});

async function checkAndResumeSessionOnLoad() {
    try {
        const host = window.location.hostname || '';
        if (!host.includes('labs.google') && !host.includes('google.com')) return;

        const res = await new Promise(r => chrome.storage.local.get(['veo_running_session'], r));
        const session = res?.veo_running_session;
        if (session && session.status === 'running' && Array.isArray(session.prompts) && session.prompts.length > 0) {
            const nextIdx = Math.max(0, parseInt(session.currentIndex || 0, 10));
            if (nextIdx < session.prompts.length) {
                console.log(`[VEO Resume] Auto-resuming session ${session.groupId} at prompt ${nextIdx + 1}/${session.prompts.length} in 3.5s...`);
                await new Promise(r => setTimeout(r, 3500));
                runAutomation({
                    ...session,
                    startFromIndex: nextIdx
                });
            }
        }
    } catch (e) {
        console.warn('[VEO Resume] Error in checkAndResumeSessionOnLoad:', e);
    }
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', checkAndResumeSessionOnLoad);
} else {
    checkAndResumeSessionOnLoad();
}
