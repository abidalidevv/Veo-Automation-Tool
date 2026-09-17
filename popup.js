const uploadedFilesRegistry = {};
const pendingGeminiPreviewResolvers = new Map();

function generateGeminiRunToken(prefix = 'gemini-run') {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function waitForGeminiPreviewByToken(runToken, timeoutMs = 180000) {
  return new Promise((resolve, reject) => {
    if (!runToken) {
      reject(new Error('Missing runToken to wait for Gemini result.'));
      return;
    }

    const timeoutId = setTimeout(() => {
      pendingGeminiPreviewResolvers.delete(runToken);
      reject(new Error('Timed out waiting for Gemini result for current batches.'));
    }, Math.max(1000, timeoutMs));

    pendingGeminiPreviewResolvers.set(runToken, {
      resolve: (payload) => {
        clearTimeout(timeoutId);
        resolve(payload);
      },
      reject: (error) => {
        clearTimeout(timeoutId);
        reject(error instanceof Error ? error : new Error(String(error || 'Gemini run failed')));
      }
    });
  });
}

function getAudioDurationSeconds(file) {
  return new Promise((resolve) => {
    if (!(file instanceof File)) {
      resolve(0);
      return;
    }

    const objectUrl = URL.createObjectURL(file);
    const audio = new Audio();

    const finalize = (value) => {
      try {
        URL.revokeObjectURL(objectUrl);
      } catch (e) { }
      resolve(Number.isFinite(value) && value > 0 ? value : 0);
    };

    audio.preload = 'metadata';
    audio.onloadedmetadata = () => finalize(audio.duration);
    audio.onerror = () => finalize(0);
    audio.src = objectUrl;
  });
}

function getVideoDurationSeconds(file) {
  return new Promise((resolve) => {
    if (!(file instanceof File)) {
      resolve(0);
      return;
    }

    const objectUrl = URL.createObjectURL(file);
    const video = document.createElement('video');

    const finalize = (value) => {
      try {
        URL.revokeObjectURL(objectUrl);
      } catch (e) { }
      resolve(Number.isFinite(value) && value > 0 ? value : 0);
    };

    video.preload = 'metadata';
    video.onloadedmetadata = () => finalize(video.duration);
    video.onerror = () => finalize(0);
    video.src = objectUrl;
  });
}

function formatSecondsToTimecode(totalSeconds) {
  const value = Math.max(0, Math.floor(Number(totalSeconds) || 0));
  const hh = String(Math.floor(value / 3600)).padStart(2, '0');
  const mm = String(Math.floor((value % 3600) / 60)).padStart(2, '0');
  const ss = String(value % 60).padStart(2, '0');
  return `${hh}:${mm}:${ss}`;
}

function stripMarkdownCodeFences(text) {
  const safe = String(text || '').trim();
  if (!safe) return '';
  return safe
    .replace(/```json\s*/gi, '')
    .replace(/```\s*/g, '')
    .trim();
}

function extractTopLevelJsonObjects(text) {
  const input = stripMarkdownCodeFences(text);
  if (!input) return [];

  const chunks = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;

  for (let i = 0; i < input.length; i++) {
    const ch = input[i];

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === '\\') {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }

    if (ch === '"') {
      inString = true;
      continue;
    }

    if (ch === '{') {
      if (depth === 0) {
        start = i;
      }
      depth += 1;
      continue;
    }

    if (ch === '}') {
      if (depth > 0) {
        depth -= 1;
      }

      if (depth === 0 && start >= 0) {
        chunks.push(input.slice(start, i + 1));
        start = -1;
      }
    }
  }

  return chunks;
}

function parseSceneObjectsFromText(text) {
  const rawObjects = extractTopLevelJsonObjects(text);
  const scenes = [];

  for (const raw of rawObjects) {
    try {
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) continue;
      const sceneNumber = Number(parsed.scene_number);
      if (!Number.isFinite(sceneNumber)) continue;
      scenes.push(parsed);
    } catch (e) { }
  }

  return scenes;
}

function formatSceneObjects(sceneObjects) {
  const list = Array.isArray(sceneObjects) ? sceneObjects : [];
  return list
    .map(scene => JSON.stringify(scene, null, 2))
    .join('\n\n')
    .trim();
}

function parseDurationToSeconds(durationText) {
  const raw = String(durationText || '').trim().toLowerCase();
  if (!raw) return 60;

  // Support values like: "60s", "1 min", "5-10 min", "3 min"
  const rangeMatch = raw.match(/(\d+(?:\.\d+)?)\s*[-~]\s*(\d+(?:\.\d+)?)/);
  const pickValue = rangeMatch
    ? Math.max(Number(rangeMatch[1]), Number(rangeMatch[2]))
    : (Number(raw.match(/\d+(?:\.\d+)?/)?.[0]) || 0);

  if (!Number.isFinite(pickValue) || pickValue <= 0) return 60;

  const isMinute = /(min|minute|minutes|m\b)/i.test(raw) && !/(ms|millisecond)/i.test(raw);
  const isSecond = /(sec|second|seconds|s\b)/i.test(raw);

  if (isMinute && !isSecond) {
    return Math.max(8, Math.round(pickValue * 60));
  }

  return Math.max(8, Math.round(pickValue));
}

function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error || new Error('FileReader error'));
    reader.readAsDataURL(file);
  });
}

async function serializeFilesForMessage(files) {
  const list = Array.isArray(files) ? files : [];
  const result = [];

  for (const file of list) {
    if (!(file instanceof File)) continue;
    try {
      const dataUrl = await fileToDataUrl(file);
      result.push({
        name: file.name,
        type: file.type,
        size: file.size,
        lastModified: file.lastModified,
        dataUrl
      });
    } catch (e) {
      console.warn('Skipped non-serializable file:', file?.name, e);
    }
  }

  return result;
}

function normalizeVideoModelValue(modelValue) {
  const raw = (modelValue || '').toLowerCase();

  if (!raw) return 'veo-3.1-fast';
  if (raw.includes('omni')) return 'omni-flash';
  if (raw.includes('veo-2-quality')) return 'veo-3.1-quality';
  if (raw.includes('veo-2-fast')) return 'veo-3.1-fast';
  if (raw.includes('lite-lower')) return 'veo-3.1-lite-lower';
  if (raw.includes('fast-lower') || raw.includes('lower')) return 'veo-3.1-fast-lower';
  if (raw.includes('quality')) return 'veo-3.1-quality';
  if (raw.includes('lite')) return 'veo-3.1-lite';
  return 'veo-3.1-fast';
}

document.addEventListener('DOMContentLoaded', () => {
  const introScreen = document.getElementById('intro-screen');
  const introEnterBtn = document.getElementById('intro-enter-btn');
  const introImageModal = document.getElementById('intro-image-modal');
  const introImageModalImg = document.getElementById('intro-image-modal-img');
  const introImageModalClose = document.getElementById('intro-image-modal-close');
  const introPopupTargets = document.querySelectorAll('[data-popup-image]');
  const copyTargets = document.querySelectorAll('[data-copy-value]');

  document.body.classList.toggle('intro-open', !!introScreen && !introScreen.classList.contains('hidden'));

  const updateHeaderNavigation = (lang = '') => {
    const backButton = document.getElementById('back-to-intro-btn');
    if (!backButton || !introScreen) return;

    const selectedLang = lang || document.querySelector('.header-lang-select')?.value || 'en';
    const introIsOpen = !introScreen.classList.contains('hidden');
    const icon = backButton.querySelector('.back-arrow-icon');
    if (icon) icon.textContent = introIsOpen ? '◀' : 'ⓘ';

    const title = introIsOpen
      ? ('Open main interface')
      : ('Developer & Social Profiles');
    backButton.title = title;
    backButton.setAttribute('aria-label', title);
  };

  document.addEventListener('intro-view-change', () => updateHeaderNavigation());
  updateHeaderNavigation();


  
  // Auto-save and restore Save-to-folder inputs
  const saveFolderInputs = document.querySelectorAll('[id^="save-to-folder-"]');
  saveFolderInputs.forEach(input => {
    input.addEventListener('input', () => {
      chrome.storage.local.set({ [input.id]: input.value });
    });
  });
  chrome.storage.local.get(null, (allData) => {
    if (allData) {
      saveFolderInputs.forEach(input => {
        if (allData[input.id] !== undefined) {
          input.value = allData[input.id];
        }
      });
    }
  });

  const autoRenameToggle = document.querySelector('.toggle-row input[type="checkbox"]');
  if (autoRenameToggle) {
    chrome.storage.local.get(['veo_auto_rename'], result => {
      if (result.veo_auto_rename !== undefined) {
        autoRenameToggle.checked = result.veo_auto_rename;
      }
    });
    autoRenameToggle.addEventListener('change', () => {
      chrome.storage.local.set({ veo_auto_rename: autoRenameToggle.checked });
    });
  }

  // Auto-save and restore Master Prompt inputs
  const masterPromptInputs = document.querySelectorAll('.master-prompt-input');
  masterPromptInputs.forEach(input => {
    input.addEventListener('input', () => {
      const key = input.id || 'master_prompt_default';
      chrome.storage.local.set({ [key]: input.value });
    });
  });
  chrome.storage.local.get(null, (allData) => {
    if (allData) {
      masterPromptInputs.forEach(input => {
        const key = input.id || 'master_prompt_default';
        if (allData[key] !== undefined) {
          input.value = allData[key];
        }
      });
    }
  });

  const nativeAutoClickToggle = document.getElementById('native-auto-click-toggle');
  if (nativeAutoClickToggle) {
    const storageGet = (keys) => new Promise(resolve => {
      try {
        chrome.storage.local.get(keys, result => resolve(result || {}));
      } catch (error) {
        resolve({});
      }
    });

    const storageSet = (value) => new Promise(resolve => {
      try {
        chrome.storage.local.set(value, () => resolve());
      } catch (error) {
        resolve();
      }
    });

    const permissionContains = (permissions) => new Promise(resolve => {
      try {
        if (!chrome.permissions || !chrome.permissions.contains) {
          resolve(false);
          return;
        }
        chrome.permissions.contains({ permissions }, granted => {
          resolve(!!granted);
        });
      } catch (error) {
        resolve(false);
      }
    });

    const permissionRequest = (permissions) => new Promise(resolve => {
      try {
        if (!chrome.permissions || !chrome.permissions.request) {
          resolve({ granted: false, error: 'chrome.permissions.request is not available' });
          return;
        }
        chrome.permissions.request({ permissions }, granted => {
          const error = chrome.runtime?.lastError?.message || '';
          resolve({ granted: !!granted, error });
        });
      } catch (error) {
        resolve({ granted: false, error: String(error?.message || error) });
      }
    });

    const permissionRemove = (permissions) => new Promise(resolve => {
      try {
        if (!chrome.permissions || !chrome.permissions.remove) {
          resolve(false);
          return;
        }
        chrome.permissions.remove({ permissions }, removed => {
          resolve(!!removed);
        });
      } catch (error) {
        resolve(false);
      }
    });

    const syncNativeAutoClickToggle = async () => {
      try {
        const [stored, permissionGranted] = await Promise.all([
          storageGet(['veo_native_auto_click']),
          permissionContains(['debugger'])
        ]);
        nativeAutoClickToggle.checked = stored.veo_native_auto_click === true && permissionGranted === true;
        if (stored.veo_native_auto_click === true && permissionGranted !== true) {
          await storageSet({ veo_native_auto_click: false });
        }
      } catch (error) {
        nativeAutoClickToggle.checked = false;
      }
    };

    syncNativeAutoClickToggle();

    nativeAutoClickToggle.addEventListener('change', async () => {
      if (nativeAutoClickToggle.checked) {
        try {
          const { granted, error } = await permissionRequest(['debugger']);
          if (!granted) {
            nativeAutoClickToggle.checked = false;
            await storageSet({ veo_native_auto_click: false });
            const reason = error ? `\n\nEdge error: ${error}` : '';
            alert(`Full auto Run needs debugger permission. Without it, Google Flow requires one real click per prompt.${reason}`);
            return;
          }
          await storageSet({ veo_native_auto_click: true });
        } catch (error) {
          nativeAutoClickToggle.checked = false;
          await storageSet({ veo_native_auto_click: false });
          alert(`Could not enable Full auto Run permission.\n\n${String(error?.message || error)}`);
        }
      } else {
        await storageSet({ veo_native_auto_click: false });
        await permissionRemove(['debugger']);
      }
    });
  }
  const openIntroImageModal = (imgSrc) => {
    if (!introImageModal || !introImageModalImg || !imgSrc) return;
    introImageModalImg.src = imgSrc;
    introImageModal.classList.remove('hidden');
  };

  const closeIntroImageModal = () => {
    if (!introImageModal || !introImageModalImg) return;
    introImageModal.classList.add('hidden');
    introImageModalImg.src = '';
  };

  if (introScreen && introEnterBtn) {
    introEnterBtn.addEventListener('click', () => {
      introScreen.classList.add('hidden');
      document.body.classList.remove('intro-open');
      updateHeaderNavigation();
    });
  }

  copyTargets.forEach((target) => {
    target.addEventListener('click', async () => {
      const value = String(target.getAttribute('data-copy-value') || '').trim();
      if (!value) return;

      let copied = false;
      try {
        await navigator.clipboard.writeText(value);
        copied = true;
      } catch (error) {
        const textarea = document.createElement('textarea');
        textarea.value = value;
        textarea.style.position = 'fixed';
        textarea.style.opacity = '0';
        document.body.appendChild(textarea);
        textarea.select();
        copied = document.execCommand('copy');
        textarea.remove();
      }

      if (!copied) return;
      const label = target.querySelector('small');
      const original = label ? label.textContent : '';
      target.classList.add('copied');
      if (label) label.textContent = 'Copied';
      window.setTimeout(() => {
        target.classList.remove('copied');
        if (label) label.textContent = original;
      }, 1600);
    });
  });

  if (introPopupTargets.length > 0) {
    introPopupTargets.forEach((target) => {
      target.addEventListener('click', () => {
        const src = String(target.getAttribute('data-popup-image') || '').trim();
        openIntroImageModal(src);
      });

      target.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          const src = String(target.getAttribute('data-popup-image') || '').trim();
          openIntroImageModal(src);
        }
      });
    });
  }

  if (introImageModal) {
    introImageModal.addEventListener('click', (event) => {
      const el = event.target;
      if (el instanceof HTMLElement && el.getAttribute('data-modal-close') === 'true') {
        closeIntroImageModal();
      }
    });
  }

  if (introImageModalClose) {
    introImageModalClose.addEventListener('click', closeIntroImageModal);
  }

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && introImageModal && !introImageModal.classList.contains('hidden')) {
      closeIntroImageModal();
    }
  });

  // ==========================================
  // 1. TAB SWITCHING AND SLIDER INDICATOR
  // ==========================================
  const mainTabs = document.querySelectorAll('.main-tab');
  const tabContents = document.querySelectorAll('.tab-content');
  const tabSlider = document.querySelector('.tab-slider');

  // Automatically calculate position for active tab indicator
  function updateSlider(activeTab) {
    if (tabSlider && activeTab) {
      tabSlider.style.width = activeTab.offsetWidth + 'px';
      tabSlider.style.left = activeTab.offsetLeft + 'px';
    }
  }

  // Position indicator on Control tab at launch
  const initialTab = document.querySelector('.main-tab.active');
  setTimeout(() => updateSlider(initialTab), 50);

  mainTabs.forEach(tab => {
    tab.addEventListener('click', () => {
      // Hide previous content
      mainTabs.forEach(t => t.classList.remove('active'));
      tabContents.forEach(c => c.classList.remove('active'));

      // Show new content
      tab.classList.add('active');
      const targetId = tab.getAttribute('data-target');
      document.getElementById(targetId).classList.add('active');

      // Slide indicator to clicked tab
      updateSlider(tab);
    });
  });

  const settingSideBtn = document.querySelector('.setting-side-btn');
  if (settingSideBtn) {
    settingSideBtn.addEventListener('click', () => {
      mainTabs.forEach(t => t.classList.remove('active'));
      tabContents.forEach(c => c.classList.remove('active'));

      const settingMainTab = document.querySelector('.main-tab[data-target="setting-tab"]');
      if (settingMainTab) {
        settingMainTab.classList.add('active');
        updateSlider(settingMainTab);
      }

      const settingContent = document.getElementById('setting-tab');
      if (settingContent) {
        settingContent.classList.add('active');
      }
    });
  }


  // ==========================================
  // ==========================================
  // 2. SWITCH MODES (Supports button and card variants)
  // ==========================================
  // Query both legacy and modern mode selectors
  const actionBtns = document.querySelectorAll('.action-btn, .action-card');
  const modeSections = document.querySelectorAll('.mode-section');
  const dynamicNote = document.getElementById('dynamic-note');

  actionBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      // Deactivate all mode buttons
      actionBtns.forEach(c => c.classList.remove('active'));
      modeSections.forEach(sec => sec.classList.remove('active'));

      // Activate clicked mode button
      btn.classList.add('active');
      const targetMode = btn.getAttribute('data-mode');
      const noteText = btn.getAttribute('data-note');
      // Toggle mode-config panels (Concurrent/Delay in wrapper)
      const modeConfigs = document.querySelectorAll('.mode-config');
      modeConfigs.forEach(mc => mc.classList.remove('active'));
      const targetModeConfig = document.querySelector(`.mode-config[data-mode-config="${targetMode}"]`);
      if (targetModeConfig) {
        targetModeConfig.classList.add('active');
      }

      // Display corresponding mode section
      const targetSection = document.getElementById(targetMode);
      if (targetSection) {
        targetSection.classList.add('active');
      }

      // Update bottom description note
      if (dynamicNote && noteText) {
        dynamicNote.textContent = noteText;
      }
    });
  });

  // ==========================================
  // 3. MAX RETRIES STEPPERS (+/-)
  // ==========================================
  const btnMinus = document.querySelector('.btn-minus');
  const btnPlus = document.querySelector('.btn-plus');
  const retriesInput = document.getElementById('max-retries');

  if (btnMinus && btnPlus && retriesInput) {
    btnMinus.addEventListener('click', () => {
      let val = parseInt(retriesInput.value) || 0;
      if (val > 1) retriesInput.value = val - 1;
    });
    btnPlus.addEventListener('click', () => {
      let val = parseInt(retriesInput.value) || 0;
      if (val < 20) retriesInput.value = val + 1;
    });
  }

  // ==========================================
  // 3.1 SCRIPT GENERATION FROM PROMPT FORM
  // ==========================================
  const cpGoal = document.getElementById('cp-goal');
  const cpMainTopic = document.getElementById('cp-main-topic');
  const cpTone = document.getElementById('cp-tone');
  const cpLanguage = document.getElementById('cp-language');
  const cpHook = document.getElementById('cp-hook');
  const cpDuration = document.getElementById('cp-duration');
  const cpCTA = document.getElementById('cp-cta');
  const cpImageStyle = document.getElementById('cp-image-style');
  const cpSetting = document.getElementById('cp-setting');
  const cpCharacterCount = document.getElementById('cp-character-count');
  const cpCharacterNames = document.getElementById('cp-character-names');
  const cpGenerateBtn = document.getElementById('cp-generate-btn');
  const cpGenerateGeminiBtn = document.getElementById('cp-generate-gemini-btn');
  const cpOutput = document.getElementById('cp-output');
  const cpPreview = document.getElementById('cp-preview');
  const cpFeatureBtns = document.querySelectorAll('.cp-feature-btn');
  const cpFeatureSections = document.querySelectorAll('.cp-feature-section');
  const cpIdeaInput = document.getElementById('cp-idea-input');
  const cpIdeaDuration = document.getElementById('cp-idea-duration');
  const cpIdeaStyle = document.getElementById('cp-idea-style');
  const cpIdeaOutput = document.getElementById('cp-idea-output');
  const cpIdeaPreview = document.getElementById('cp-preview-idea');
  const cpIdeaGenerateBtn = document.getElementById('cp-idea-generate-btn');
  const cvFeatureBtns = document.querySelectorAll('.cv-feature-btn');
  const cvFeatureSections = document.querySelectorAll('.cv-feature-section');
  const cvAudioUploadZone = document.getElementById('cv-audio-upload-zone');
  const cvAudioFileInput = document.getElementById('cv-audio-file');
  const cvAudioFileName = document.getElementById('cv-audio-file-name');
  const cvAudioPromptPreview = document.getElementById('cv-audio-prompt-preview');
  const cvAudioNote = document.getElementById('cv-audio-note');
  const cvRunAudioBtn = document.getElementById('cv-run-audio-btn');
  const cvVideoUploadZone = document.getElementById('cv-video-upload-zone');
  const cvVideoFileInput = document.getElementById('cv-video-file');
  const cvVideoFileName = document.getElementById('cv-video-file-name');
  const cvVideoSource = document.getElementById('cv-video-source');
  const cvVideoNote = document.getElementById('cv-video-note');
  const cvVideoPromptPreview = document.getElementById('cv-video-prompt-preview');
  const cvRunVideoBtn = document.getElementById('cv-run-video-btn');

  const renderCvAudioPromptPreview = (file) => {
    if (!cvAudioPromptPreview) return;

    if (!file || !String(file.type || '').startsWith('audio/')) {
      cvAudioPromptPreview.value = '';
      return;
    }

    const fileType = String(file.type || 'audio/unknown').replace('audio/', '').toUpperCase();
    cvAudioPromptPreview.value = [
      'Create a video generation prompt based on the input audio with the following specifications:',
      `- Audio filename: ${file.name}`,
      `- Format: ${fileType}`,
      '- Analyze rhythm, emotion, climax, and tempo transitions of the audio to construct synchronized video scenes.',
      '- Generate continuous 8-second scenes with smooth transitions and consistent visual narrative.',
      '- Return detailed visual prompts ready for video generation.'
    ].join('\n');
  };

  const updateCvAudioSelection = (file) => {
    if (!file || !String(file.type || '').startsWith('audio/')) {
      if (cvAudioFileName) {
        cvAudioFileName.textContent = 'Please select a valid audio file.';
      }
      if (cvAudioUploadZone) {
        cvAudioUploadZone.classList.remove('has-file');
      }
      uploadedFilesRegistry['clone-video-audio'] = [];
      renderCvAudioPromptPreview(null);
      return;
    }

    uploadedFilesRegistry['clone-video-audio'] = [file];

    if (cvAudioFileName) {
      cvAudioFileName.textContent = `Selected: ${file.name}`;
    }
    if (cvAudioUploadZone) {
      cvAudioUploadZone.classList.add('has-file');
    }
    renderCvAudioPromptPreview(file);
  };

  const updateCvVideoSelection = (file) => {
    if (!file || !String(file.type || '').startsWith('video/')) {
      uploadedFilesRegistry['clone-video-video'] = [];
      if (cvVideoFileName) {
        cvVideoFileName.textContent = 'Please select a valid video file.';
      }
      if (cvVideoUploadZone) {
        cvVideoUploadZone.classList.remove('has-file');
      }
      return;
    }

    uploadedFilesRegistry['clone-video-video'] = [file];
    if (cvVideoFileName) {
      cvVideoFileName.textContent = `Selected: ${file.name}`;
    }
    if (cvVideoUploadZone) {
      cvVideoUploadZone.classList.add('has-file');
    }
  };

  if (cvAudioUploadZone && cvAudioFileInput) {
    cvAudioUploadZone.addEventListener('click', () => {
      cvAudioFileInput.click();
    });

    cvAudioUploadZone.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        cvAudioFileInput.click();
      }
    });

    cvAudioFileInput.addEventListener('change', (event) => {
      const file = event.target.files && event.target.files[0] ? event.target.files[0] : null;
      updateCvAudioSelection(file);
    });

    cvAudioUploadZone.addEventListener('dragover', (event) => {
      event.preventDefault();
      cvAudioUploadZone.classList.add('dragover');
    });

    cvAudioUploadZone.addEventListener('dragleave', (event) => {
      event.preventDefault();
      cvAudioUploadZone.classList.remove('dragover');
    });

    cvAudioUploadZone.addEventListener('drop', (event) => {
      event.preventDefault();
      cvAudioUploadZone.classList.remove('dragover');
      const file = event.dataTransfer?.files && event.dataTransfer.files[0]
        ? event.dataTransfer.files[0]
        : null;
      updateCvAudioSelection(file);
    });
  }

  if (cvVideoUploadZone && cvVideoFileInput) {
    cvVideoUploadZone.addEventListener('click', () => {
      cvVideoFileInput.click();
    });

    cvVideoUploadZone.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        cvVideoFileInput.click();
      }
    });

    cvVideoFileInput.addEventListener('change', (event) => {
      const file = event.target.files && event.target.files[0] ? event.target.files[0] : null;
      updateCvVideoSelection(file);
    });

    cvVideoUploadZone.addEventListener('dragover', (event) => {
      event.preventDefault();
      cvVideoUploadZone.classList.add('dragover');
    });

    cvVideoUploadZone.addEventListener('dragleave', (event) => {
      event.preventDefault();
      cvVideoUploadZone.classList.remove('dragover');
    });

    cvVideoUploadZone.addEventListener('drop', (event) => {
      event.preventDefault();
      cvVideoUploadZone.classList.remove('dragover');
      const file = event.dataTransfer?.files && event.dataTransfer.files[0]
        ? event.dataTransfer.files[0]
        : null;
      updateCvVideoSelection(file);
    });
  }

  if (cvFeatureBtns.length > 0 && cvFeatureSections.length > 0) {
    cvFeatureBtns.forEach(btn => {
      btn.addEventListener('click', () => {
        cvFeatureBtns.forEach(item => item.classList.remove('active'));
        cvFeatureSections.forEach(sec => sec.classList.remove('active'));

        btn.classList.add('active');
        const targetId = btn.getAttribute('data-cv-feature');
        const target = targetId ? document.getElementById(targetId) : null;
        if (target) {
          target.classList.add('active');
        }
      });
    });
  }

  if (cpFeatureBtns.length > 0 && cpFeatureSections.length > 0) {
    cpFeatureBtns.forEach(btn => {
      btn.addEventListener('click', () => {
        cpFeatureBtns.forEach(item => item.classList.remove('active'));
        cpFeatureSections.forEach(sec => sec.classList.remove('active'));

        btn.classList.add('active');
        const targetId = btn.getAttribute('data-cp-feature');
        const target = targetId ? document.getElementById(targetId) : null;
        if (target) {
          target.classList.add('active');
        }
      });
    });
  }

  if (cpPreview) {
    chrome.storage.local.get(['geminiPreviewContent'], (result) => {
      const saved = String(result?.geminiPreviewContent || '').trim();
      if (saved) {
        cpPreview.value = saved;
        if (cpIdeaPreview) cpIdeaPreview.value = saved;
      }
    });
  }

  const getSafeValue = (el, fallback = '') => {
    if (!el) return fallback;
    const value = String(el.value || '').trim();
    return value || fallback;
  };

  const getToneValues = (toneEl) => {
    if (!toneEl) return [];

    return String(toneEl.value || '')
      .split(/[\n,;]+/)
      .map(item => item.trim())
      .filter(Boolean);
  };

  const sendPromptToGeminiTab = (tabId, promptText, options = {}, maxAttempts = 30, retryDelayMs = 400) => {
    return new Promise((resolve) => {
      let attempts = 0;

      const trySend = () => {
        attempts += 1;

        chrome.tabs.sendMessage(tabId, {
          action: 'AUTO_FILL_GEMINI_PROMPT',
          promptText,
          uploadedFiles: Array.isArray(options?.uploadedFiles) ? options.uploadedFiles : [],
          runToken: String(options?.runToken || '')
        }, (response) => {
          if (!chrome.runtime.lastError && response?.ok) {
            resolve({ ok: true, message: response?.message || '' });
            return;
          }

          if (attempts >= maxAttempts) {
            const runtimeError = chrome.runtime.lastError?.message || '';
            resolve({ ok: false, error: runtimeError || response?.message || 'Could not send auto-fill command to Gemini tab.' });
            return;
          }

          setTimeout(trySend, retryDelayMs);
        });
      };

      trySend();
    });
  };

  const openGeminiTabWithPrompt = async (promptText, options = {}) => {
    const uploadedFiles = Array.isArray(options?.uploadedFiles) ? options.uploadedFiles : [];
    const runToken = String(options?.runToken || '');

    try {
      const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
      const flowTabId = activeTab?.id;

      await chrome.storage.local.set({
        pendingGeminiPrompt: promptText,
        pendingGeminiUploadedFiles: uploadedFiles,
        pendingGeminiRunToken: runToken,
        flowReturnTabId: flowTabId || null
      });

      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(promptText);
      }

      const geminiTab = await chrome.tabs.create({ url: 'https://gemini.google.com/app' });

      if (!geminiTab?.id) {
        return { ok: true, copied: true, autoFilled: false, error: 'Could not retrieve Gemini tab ID.', tabId: null };
      }

      const autoFillResult = await sendPromptToGeminiTab(geminiTab.id, promptText, { uploadedFiles, runToken });
      return {
        ok: true,
        copied: true,
        autoFilled: autoFillResult.ok,
        error: autoFillResult.ok ? '' : autoFillResult.error,
        tabId: geminiTab.id
      };
    } catch (error) {
      let fallbackTabId = null;
      try {
        const fallbackTab = await chrome.tabs.create({ url: 'https://gemini.google.com/app' });
        fallbackTabId = fallbackTab?.id || null;
      } catch (tabError) {
        return { ok: false, error: tabError?.message || String(tabError) };
      }

      if (fallbackTabId) {
        const autoFillResult = await sendPromptToGeminiTab(fallbackTabId, promptText, { uploadedFiles, runToken });
        return {
          ok: true,
          copied: false,
          autoFilled: autoFillResult.ok,
          error: autoFillResult.ok ? (error?.message || String(error)) : (autoFillResult.error || error?.message || String(error)),
          tabId: fallbackTabId
        };
      }

      return { ok: true, copied: false, autoFilled: false, error: error?.message || String(error), tabId: null };
    }
  };

  const buildCloneAudioBatchInstruction = ({
    batchSize,
    startScene,
    endScene,
    totalScenes,
    totalDurationSeconds,
    audioName,
    previousSceneContext,
    previewHint,
    noteText
  }) => {
    const safeBatchSize = Math.max(1, Number(batchSize) || 1);
    const safeStart = Math.max(1, Number(startScene) || 1);
    const safeEnd = Math.max(safeStart, Number(endScene) || safeStart);
    const safeTotalScenes = Math.max(safeEnd, Number(totalScenes) || safeEnd);
    const totalDuration = Math.max(8, Number(totalDurationSeconds) || (safeTotalScenes * 8));

    const contextBlock = previousSceneContext
      ? `\nCONTEXT OF PREVIOUS SCENES (for visual continuity, DO NOT rewrite):\n${previousSceneContext}`
      : '';

    const previewBlock = previewHint
      ? `\nADDITIONAL USER REQUIREMENTS:\n${previewHint}`
      : '';

    const noteBlock = noteText
      ? `\nUSER CUSTOMIZATION NOTES:\n${noteText}`
      : '';

    const sceneTimecodes = [];
    for (let s = safeStart; s <= safeEnd; s++) {
      const startSec = (s - 1) * 8;
      const endSec = s * 8;
      sceneTimecodes.push(`\n- Scene ${s}: ${formatSecondsToTimecode(startSec)} - ${formatSecondsToTimecode(endSec)}`);
    }
    const timecodeLinesBlock = sceneTimecodes.length > 0
      ? `\nMANDATORY TIMECODES FOR EACH SCENE:${sceneTimecodes.join('')}`
      : '';

    const strictSceneSchema = `{
  "scene_number": 1,
  "timecode": "00:00 - 00:08",
  "scene_setting": "...",
  "style": "...",
  "camera": "...",
  "lighting": "...",
  "sound": "...",
  "character": [
    {
      "name": "...",
      "biology_and_anatomy": "...",
      "clothing_and_materials": "...",
      "accessories": "...",
      "action": "...",
      "expression": "..."
    }
  ],
  "narration": "...",
  "dialogue": [
    {
      "character": "...",
      "line": "..."
    }
  ]
}`;

    return [
      `You are writing a video screenplay continuation from audio file: ${audioName}.`,
      `Total target duration: approximately ${Math.round(totalDuration)} seconds (~${Math.ceil(totalDuration / 60)} minutes), corresponding to ~${safeTotalScenes} scenes (8s each).`,
      `GENERATE EXACTLY ${safeBatchSize} new scenes, numbered from scene_number ${safeStart} to ${safeEnd}.`,
      'MANDATORY continuity rules:',
      '- Must logically follow preceding scenes (storyline, emotional tempo, visual action).',
      '- Maintain strict character identity throughout: biology_and_anatomy, clothing_and_materials, accessories must remain consistent.',
      '- Only update dynamic attributes based on narrative progression: action, expression, environmental interaction.',
      '- Scene settings must maintain a cohesive world: specify location, time of day, lighting, and ambient sound.',
      '- Each scene must detail camera, lighting, sound, narration, and dialogue.',
      'Mandatory output format:',
      '- ONLY valid JSON, NO markdown fences (do not use ```json), NO conversational explanations.',
      '- Each scene must be an independent JSON object, separated by exactly 1 blank line, NOT wrapped in an array [].',
      '- Each scene MUST include all keys: scene_number, timecode, scene_setting, style, camera, lighting, sound, character, narration, dialogue.',
      '- DO NOT duplicate past scenes, DO NOT generate scenes outside the requested scene_number range.',
      'Mandatory schema for EACH scene:',
      strictSceneSchema
    ].join('\n') + timecodeLinesBlock + noteBlock + previewBlock + contextBlock;
  };

  const buildCloneVideoBatchInstruction = ({
    batchSize,
    startScene,
    endScene,
    totalScenes,
    totalDurationSeconds,
    videoName,
    previousSceneContext,
    noteText
  }) => {
    const safeBatchSize = Math.max(1, Number(batchSize) || 1);
    const safeStart = Math.max(1, Number(startScene) || 1);
    const safeEnd = Math.max(safeStart, Number(endScene) || safeStart);
    const safeTotalScenes = Math.max(safeEnd, Number(totalScenes) || safeEnd);
    const totalDuration = Math.max(8, Number(totalDurationSeconds) || (safeTotalScenes * 8));

    const blockStartSecond = (safeStart - 1) * 8;
    const blockEndSecond = Math.min(totalDuration, safeEnd * 8);

    const contextBlock = previousSceneContext
      ? `\nCONTEXT OF PREVIOUS SCENES (for visual continuity, DO NOT rewrite):\n${previousSceneContext}`
      : '';

    const noteBlock = noteText
      ? `\nVIDEO CLONING REQUIREMENTS:\n${noteText}`
      : '';

    const sceneTimecodes = [];
    for (let s = safeStart; s <= safeEnd; s++) {
      const startSec = (s - 1) * 8;
      const endSec = s * 8;
      sceneTimecodes.push(`\n- Scene ${s}: ${formatSecondsToTimecode(startSec)} - ${formatSecondsToTimecode(endSec)}`);
    }
    const timecodeLinesBlock = sceneTimecodes.length > 0
      ? `\nMANDATORY TIMECODES FOR EACH SCENE:${sceneTimecodes.join('')}`
      : '';

    const strictSceneSchema = `{
  "scene_number": 1,
  "timecode": "00:00 - 00:08",
  "scene_setting": "...",
  "style": "...",
  "camera": "...",
  "lighting": "...",
  "sound": "...",
  "character": [
    {
      "name": "...",
      "biology_and_anatomy": "...",
      "clothing_and_materials": "...",
      "accessories": "...",
      "action": "...",
      "expression": "..."
    }
  ],
  "narration": "...",
  "dialogue": [
    {
      "character": "...",
      "line": "..."
    }
  ]
}`;

    return [
      `You are writing a video screenplay continuation from video file: ${videoName}.`,
      `Total target duration: approximately ${Math.round(totalDuration)} seconds (~${Math.ceil(totalDuration / 60)} minutes), corresponding to ~${safeTotalScenes} scenes (8s each).`,
      `GENERATE EXACTLY ${safeBatchSize} new scenes, numbered from scene_number ${safeStart} to ${safeEnd}.`,
      'MANDATORY continuity rules:',
      '- Must logically follow preceding scenes (storyline, emotional tempo, visual action).',
      '- Maintain strict character identity throughout: biology_and_anatomy, clothing_and_materials, accessories must remain consistent.',
      '- Only update dynamic attributes based on narrative progression: action, expression, environmental interaction.',
      '- Scene settings must maintain a cohesive world: specify location, time of day, lighting, and ambient sound.',
      '- Each scene must detail camera, lighting, sound, narration, and dialogue.',
      'Mandatory output format:',
      '- ONLY valid JSON, NO markdown fences (do not use ```json), NO conversational explanations.',
      '- Each scene must be an independent JSON object, separated by exactly 1 blank line, NOT wrapped in an array [].',
      '- Each scene MUST include all keys: scene_number, timecode, scene_setting, style, camera, lighting, sound, character, narration, dialogue.',
      '- DO NOT duplicate past scenes, DO NOT generate scenes outside the requested scene_number range.',
      'Mandatory schema for EACH scene:',
      strictSceneSchema
    ].join('\n') + timecodeLinesBlock + noteBlock + contextBlock;
  };

  const buildCloneAudioPromptInstruction = () => {
    const previewPrompt = String(cvAudioPromptPreview?.value || '').trim();
    if (previewPrompt) {
      return `${previewPrompt}\n\nMANDATORY: Directly analyze the attached audio file to craft detailed video prompts; do not ignore the audio input.`.trim();
    }

    return [
      'Write detailed video generation prompts based on the attached audio file.',
      '- Analyze rhythm, emotion, climax, and tempo transitions of the audio.',
      '- Propose cinematic prompts structured into consecutive 8-second scenes.',
      '- Return clear prompts immediately usable for video generation.',
      'MANDATORY: Visuals must directly reflect the content and mood of the attached audio.'
    ].join('\n');
  };

  if (cvRunAudioBtn) {
    cvRunAudioBtn.addEventListener('click', async () => {
      const selectedAudio = (uploadedFilesRegistry['clone-video-audio'] || [])[0] || null;
      const noteText = String(cvAudioNote?.value || '').trim();
      if (!selectedAudio) {
        alert('Please upload an audio file before generating with Gemini.');
        return;
      }

      const serializedAudioFiles = await serializeFilesForMessage([selectedAudio]);
      if (!Array.isArray(serializedAudioFiles) || serializedAudioFiles.length === 0) {
        alert('Could not read audio file. Please re-select the file and try again.');
        return;
      }

      const audioDurationSeconds = await getAudioDurationSeconds(selectedAudio);
      const durationFallback = 300; // fallback 5 min if metadata unavailable
      const effectiveDuration = audioDurationSeconds > 0 ? audioDurationSeconds : durationFallback;
      const totalScenes = Math.max(1, Math.ceil(effectiveDuration / 8));
      const batchSize = 5;
      const totalBatches = Math.ceil(totalScenes / batchSize);

      let geminiTabId = null;
      let combinedOutput = '';
      const sceneMap = new Map();
      const previewHint = String(cvAudioPromptPreview?.value || '').trim();

      if (cvAudioPromptPreview) {
        cvAudioPromptPreview.value = `Preparing to generate ${totalScenes} scenes (~${Math.round(effectiveDuration)}s) across ${totalBatches} batches, ${batchSize} scenes per batches...`;
      }

      try {
        for (let batchIndex = 0; batchIndex < totalBatches; batchIndex++) {
          const startScene = (batchIndex * batchSize) + 1;
          const endScene = Math.min(totalScenes, startScene + batchSize - 1);
          const currentBatchSize = endScene - startScene + 1;

          let batchSuccess = false;
          let lastBatchError = null;
          const maxBatchRetries = 2;

          for (let retryAttempt = 0; retryAttempt <= maxBatchRetries && !batchSuccess; retryAttempt++) {
            try {
              const runToken = generateGeminiRunToken('clone-audio');

              const previousSceneContext = combinedOutput
                ? combinedOutput.slice(-8000)
                : '';

              const instructionPrompt = buildCloneAudioBatchInstruction({
                batchSize: currentBatchSize,
                startScene,
                endScene,
                totalScenes,
                totalDurationSeconds: effectiveDuration,
                audioName: selectedAudio.name,
                previousSceneContext,
                previewHint,
                noteText
              });

              const retryLabel = retryAttempt > 0 ? ` (Retry ${retryAttempt}/${maxBatchRetries})` : '';
              if (cvAudioPromptPreview) {
                cvAudioPromptPreview.value = [
                  `Running batch ${batchIndex + 1}/${totalBatches}${retryLabel}...`,
                  `Scene ${startScene}-${endScene}/${totalScenes}`,
                  '',
                  combinedOutput || '(no scene data yet)'
                ].join('\n');
              }

              const previewWaiter = waitForGeminiPreviewByToken(runToken, 240000);
              let submitResult = null;

              if (!geminiTabId) {
                console.log(`[Clone-Audio] Batch ${batchIndex + 1}: Opening new Gemini tab...`);
                submitResult = await openGeminiTabWithPrompt(instructionPrompt, {
                  uploadedFiles: serializedAudioFiles,
                  runToken
                });
                if (submitResult?.tabId) {
                  geminiTabId = submitResult.tabId;
                }
              } else {
                console.log(`[Clone-Audio] Batch ${batchIndex + 1}: Sending prompt to Gemini tab (${geminiTabId})...`);
                submitResult = await sendPromptToGeminiTab(geminiTabId, instructionPrompt, {
                  runToken
                }, 30, 500);
              }

              if (!submitResult?.ok) {
                lastBatchError = new Error(`[Prompt Submission Failed] ${submitResult?.error || submitResult?.message || `Could not send batch ${batchIndex + 1} to Gemini.`}`);
                console.error(`[Clone-Audio] Batch ${batchIndex + 1}:`, lastBatchError.message);
                if (retryAttempt < maxBatchRetries) {
                  console.log(`[Clone-Audio] Batch ${batchIndex + 1}: Waiting 2s before retry...`);
                  await new Promise(r => setTimeout(r, 2000));
                  continue;
                }
                throw lastBatchError;
              }

              if (submitResult?.autoFilled === false) {
                lastBatchError = new Error(`[Auto-fill Failed] ${submitResult?.error || `Gemini did not auto-fill prompt for batch ${batchIndex + 1}`}`);
                console.warn(`[Clone-Audio] Batch ${batchIndex + 1}:`, lastBatchError.message);
              }

              console.log(`[Clone-Audio] Batch ${batchIndex + 1}: Waiting for Gemini result (timeout: 4 min)...`);
              const batchPreviewPayload = await previewWaiter;
              const batchPreviewText = String(batchPreviewPayload?.previewText || '').trim();

              if (!batchPreviewText) {
                lastBatchError = new Error(`[Empty Response] Batch ${batchIndex + 1} returned no scene data (previewText is empty).`);
                console.error(`[Clone-Audio] Batch ${batchIndex + 1}:`, lastBatchError.message);
                if (retryAttempt < maxBatchRetries) {
                  console.log(`[Clone-Audio] Batch ${batchIndex + 1}: Waiting 2s before retry...`);
                  await new Promise(r => setTimeout(r, 2000));
                  continue;
                }
                throw lastBatchError;
              }

              console.log(`[Clone-Audio] Batch ${batchIndex + 1}: Received ${batchPreviewText.split('{').length - 1} scene objects`);

              const parsedScenes = parseSceneObjectsFromText(batchPreviewText);
              console.log(`[Clone-Audio] Batch ${batchIndex + 1}: Parsed ${parsedScenes.length} valid scene objects`);

              const rangedScenes = parsedScenes.filter(scene => {
                const num = Number(scene?.scene_number);
                return Number.isFinite(num) && num >= startScene && num <= endScene;
              });

              console.log(`[Clone-Audio] Batch ${batchIndex + 1}: ${rangedScenes.length} scenes within range [${startScene}-${endScene}], ${parsedScenes.length - rangedScenes.length} scenes outside range`);

              const scenesToUse = rangedScenes.length > 0 ? rangedScenes : parsedScenes;
              if (scenesToUse.length === 0) {
                lastBatchError = new Error(`[Parse Error] Batch ${batchIndex + 1} returned JSON but no valid scene_number could be parsed.`);
                console.error(`[Clone-Audio] Batch ${batchIndex + 1}:`, lastBatchError.message);
                if (retryAttempt < maxBatchRetries) {
                  console.log(`[Clone-Audio] Batch ${batchIndex + 1}: Waiting 2s before retry...`);
                  await new Promise(r => setTimeout(r, 2000));
                  continue;
                }
                throw lastBatchError;
              }

              scenesToUse.forEach(scene => {
                const num = Number(scene?.scene_number);
                if (!Number.isFinite(num)) return;
                sceneMap.set(num, scene);
              });

              const orderedScenes = Array.from(sceneMap.entries())
                .sort((a, b) => a[0] - b[0])
                .map(([, scene]) => scene);

              combinedOutput = formatSceneObjects(orderedScenes);
              console.log(`[Clone-Audio] Batch ${batchIndex + 1}: Completed. Total ${sceneMap.size} unique scenes`);

              if (cvAudioPromptPreview) {
                cvAudioPromptPreview.value = combinedOutput;
              }

              batchSuccess = true;
            } catch (batchError) {
              lastBatchError = batchError;
              if (retryAttempt < maxBatchRetries) {
                console.log(`[Clone-Audio] Batch ${batchIndex + 1} Retry ${retryAttempt + 1}/${maxBatchRetries}: Error: ${batchError?.message}`);
                await new Promise(r => setTimeout(r, 2000));
              } else {
                console.error(`[Clone-Audio] Batch ${batchIndex + 1}: All ${maxBatchRetries + 1} retry attempts failed.`);
                throw batchError;
              }
            }
          }
        }

        if (cvAudioPromptPreview && combinedOutput) {
          cvAudioPromptPreview.value = combinedOutput;
        }

        const completionMsg = `✓ Complete! Total scenes: ${sceneMap.size}/${totalScenes}, batches: ${totalBatches}. Data displayed in preview.`;
        console.log(`[Clone-Audio] ${completionMsg}`);
        alert(completionMsg);
      } catch (error) {
        const errorMsg = error?.message || String(error);
        console.error(`[Clone-Audio] STOPPED (unrecoverable):`, errorMsg);
        if (cvAudioPromptPreview) {
          cvAudioPromptPreview.value = combinedOutput || String(cvAudioPromptPreview.value || '');
        }
        alert(`Batch prompt generation stopped:

${errorMsg}

Press F12 to inspect console errors.`);
      }
    });
  }

  if (cvRunVideoBtn) {
    cvRunVideoBtn.addEventListener('click', async () => {
      const selectedVideo = (uploadedFilesRegistry['clone-video-video'] || [])[0] || null;
      const noteText = String(cvVideoNote?.value || '').trim();

      if (!selectedVideo) {
        alert('Please upload a video file before generating with Gemini.');
        return;
      }

      const serializedVideoFiles = await serializeFilesForMessage([selectedVideo]);
      if (!Array.isArray(serializedVideoFiles) || serializedVideoFiles.length === 0) {
        alert('Could not read video file. Please re-select the file and try again.');
        return;
      }

      const videoDurationSeconds = await getVideoDurationSeconds(selectedVideo);
      const durationFallback = 60; // fallback 1 min if metadata unavailable
      const effectiveDuration = videoDurationSeconds > 0 ? videoDurationSeconds : durationFallback;
      const totalScenes = Math.max(1, Math.ceil(effectiveDuration / 8));
      const batchSize = 5;
      const totalBatches = Math.ceil(totalScenes / batchSize);

      let geminiTabId = null;
      let combinedOutput = '';
      const sceneMap = new Map();

      if (cvVideoPromptPreview) {
        cvVideoPromptPreview.value = `Preparing to generate ${totalScenes} scenes (~${Math.round(effectiveDuration)}s) across ${totalBatches} batches, ${batchSize} scenes per batches...`;
      }

      try {
        for (let batchIndex = 0; batchIndex < totalBatches; batchIndex++) {
          const startScene = (batchIndex * batchSize) + 1;
          const endScene = Math.min(totalScenes, startScene + batchSize - 1);
          const currentBatchSize = endScene - startScene + 1;

          let batchSuccess = false;
          let lastBatchError = null;
          const maxBatchRetries = 2;

          for (let retryAttempt = 0; retryAttempt <= maxBatchRetries && !batchSuccess; retryAttempt++) {
            try {
              const runToken = generateGeminiRunToken('clone-video');

              const previousSceneContext = combinedOutput
                ? combinedOutput.slice(-8000)
                : '';

              const instructionPrompt = buildCloneVideoBatchInstruction({
                batchSize: currentBatchSize,
                startScene,
                endScene,
                totalScenes,
                totalDurationSeconds: effectiveDuration,
                videoName: selectedVideo.name,
                previousSceneContext,
                noteText
              });

              const retryLabel = retryAttempt > 0 ? ` (Retry ${retryAttempt}/${maxBatchRetries})` : '';
              if (cvVideoPromptPreview) {
                cvVideoPromptPreview.value = [
                  `Running batch ${batchIndex + 1}/${totalBatches}${retryLabel}...`,
                  `Scene ${startScene}-${endScene}/${totalScenes}`,
                  '',
                  combinedOutput || '(no scene data yet)'
                ].join('\n');
              }

              const previewWaiter = waitForGeminiPreviewByToken(runToken, 240000);
              let submitResult = null;

              if (!geminiTabId) {
                console.log(`[Clone-Video] Batch ${batchIndex + 1}: Opening new Gemini tab...`);
                submitResult = await openGeminiTabWithPrompt(instructionPrompt, {
                  uploadedFiles: serializedVideoFiles,
                  runToken
                });
                if (submitResult?.tabId) {
                  geminiTabId = submitResult.tabId;
                }
              } else {
                console.log(`[Clone-Video] Batch ${batchIndex + 1}: Sending prompt to Gemini tab (${geminiTabId})...`);
                submitResult = await sendPromptToGeminiTab(geminiTabId, instructionPrompt, {
                  runToken
                }, 30, 500);
              }

              if (!submitResult?.ok) {
                lastBatchError = new Error(`[Prompt Submission Failed] ${submitResult?.error || submitResult?.message || `Could not send batch ${batchIndex + 1} to Gemini.`}`);
                console.error(`[Clone-Video] Batch ${batchIndex + 1}:`, lastBatchError.message);
                if (retryAttempt < maxBatchRetries) {
                  console.log(`[Clone-Video] Batch ${batchIndex + 1}: Waiting 2s before retry...`);
                  await new Promise(r => setTimeout(r, 2000));
                  continue;
                }
                throw lastBatchError;
              }

              if (submitResult?.autoFilled === false) {
                lastBatchError = new Error(`[Auto-fill Failed] ${submitResult?.error || `Gemini did not auto-fill prompt for batch ${batchIndex + 1}`}`);
                console.warn(`[Clone-Video] Batch ${batchIndex + 1}:`, lastBatchError.message);
              }

              console.log(`[Clone-Video] Batch ${batchIndex + 1}: Waiting for Gemini result (timeout: 4 min)...`);
              const batchPreviewPayload = await previewWaiter;
              const batchPreviewText = String(batchPreviewPayload?.previewText || '').trim();

              if (!batchPreviewText) {
                lastBatchError = new Error(`[Empty Response] Batch ${batchIndex + 1} returned no scene data (previewText is empty).`);
                console.error(`[Clone-Video] Batch ${batchIndex + 1}:`, lastBatchError.message);
                if (retryAttempt < maxBatchRetries) {
                  console.log(`[Clone-Video] Batch ${batchIndex + 1}: Waiting 2s before retry...`);
                  await new Promise(r => setTimeout(r, 2000));
                  continue;
                }
                throw lastBatchError;
              }

              console.log(`[Clone-Video] Batch ${batchIndex + 1}: Received ${batchPreviewText.split('{').length - 1} scene objects`);

              const parsedScenes = parseSceneObjectsFromText(batchPreviewText);
              console.log(`[Clone-Video] Batch ${batchIndex + 1}: Parsed ${parsedScenes.length} valid scene objects`);

              const rangedScenes = parsedScenes.filter(scene => {
                const num = Number(scene?.scene_number);
                return Number.isFinite(num) && num >= startScene && num <= endScene;
              });

              console.log(`[Clone-Video] Batch ${batchIndex + 1}: ${rangedScenes.length} scenes within range [${startScene}-${endScene}], ${parsedScenes.length - rangedScenes.length} scenes outside range`);

              const scenesToUse = rangedScenes.length > 0 ? rangedScenes : parsedScenes;
              if (scenesToUse.length === 0) {
                lastBatchError = new Error(`[Parse Error] Batch ${batchIndex + 1} returned JSON but no valid scene_number could be parsed.`);
                console.error(`[Clone-Video] Batch ${batchIndex + 1}:`, lastBatchError.message);
                if (retryAttempt < maxBatchRetries) {
                  console.log(`[Clone-Video] Batch ${batchIndex + 1}: Waiting 2s before retry...`);
                  await new Promise(r => setTimeout(r, 2000));
                  continue;
                }
                throw lastBatchError;
              }

              scenesToUse.forEach(scene => {
                const num = Number(scene?.scene_number);
                if (!Number.isFinite(num)) return;
                sceneMap.set(num, scene);
              });

              const orderedScenes = Array.from(sceneMap.entries())
                .sort((a, b) => a[0] - b[0])
                .map(([, scene]) => scene);

              combinedOutput = formatSceneObjects(orderedScenes);
              console.log(`[Clone-Video] Batch ${batchIndex + 1}: Completed. Total ${sceneMap.size} unique scenes`);

              if (cvVideoPromptPreview) {
                cvVideoPromptPreview.value = combinedOutput;
              }

              batchSuccess = true;
            } catch (batchError) {
              lastBatchError = batchError;
              if (retryAttempt < maxBatchRetries) {
                console.log(`[Clone-Video] Batch ${batchIndex + 1} Retry ${retryAttempt + 1}/${maxBatchRetries}: Error: ${batchError?.message}`);
                await new Promise(r => setTimeout(r, 2000));
              } else {
                console.error(`[Clone-Video] Batch ${batchIndex + 1}: All ${maxBatchRetries + 1} retry attempts failed.`);
                throw batchError;
              }
            }
          }
        }

        if (cvVideoPromptPreview && combinedOutput) {
          cvVideoPromptPreview.value = combinedOutput;
        }

        const completionMsg = `✓ Complete! Total scenes: ${sceneMap.size}/${totalScenes}, batches: ${totalBatches}. Data displayed in preview.`;
        console.log(`[Clone-Video] ${completionMsg}`);
        alert(completionMsg);
      } catch (error) {
        const errorMsg = error?.message || String(error);
        console.error(`[Clone-Video] STOPPED (unrecoverable):`, errorMsg);
        if (cvVideoPromptPreview) {
          cvVideoPromptPreview.value = combinedOutput || String(cvVideoPromptPreview.value || '');
        }
        alert(`Batch prompt generation stopped:

${errorMsg}

Press F12 to inspect console errors.`);
      }
    });
  }

  const renderCharacterNameInputs = () => {
    if (!cpCharacterNames || !cpCharacterCount) return;

    const count = Number.parseInt(cpCharacterCount.value, 10) || 1;
    const currentValues = Array.from(cpCharacterNames.querySelectorAll('input'))
      .map(input => String(input.value || '').trim());

    let html = '';
    for (let index = 0; index < count; index++) {
      const existingValue = currentValues[index] || '';
      html += `
        <input
          type="text"
          class="cp-character-name"
          data-index="${index + 1}"
          value="${existingValue.replace(/"/g, '&quot;')}"
          placeholder="Character ${index + 1} Name"
        />
      `;
    }

    cpCharacterNames.innerHTML = html;
  };

  if (cpCharacterCount) {
    cpCharacterCount.addEventListener('change', renderCharacterNameInputs);
    renderCharacterNameInputs();
  }

  const buildPromptFromCreateForm = () => {
    const goal = getSafeValue(cpGoal, 'Educational / Informational');
    const mainTopic = getSafeValue(cpMainTopic, 'Productivity hacks for creators');
    const tones = getToneValues(cpTone);
    const language = getSafeValue(cpLanguage, 'English');
    const hook = getSafeValue(cpHook, 'Common misconception alert');
    const duration = getSafeValue(cpDuration, '60s');
    const cta = getSafeValue(cpCTA, 'Like and follow for more!');
    const imageStyle = getSafeValue(cpImageStyle, 'Photorealistic');
    const setting = getSafeValue(cpSetting, 'Modern creative studio');
    const characterCount = Number.parseInt(getSafeValue(cpCharacterCount, '1'), 10) || 1;
    const characterNames = cpCharacterNames
      ? Array.from(cpCharacterNames.querySelectorAll('.cp-character-name'))
        .map(input => String(input.value || '').trim())
        .filter(Boolean)
      : [];
    const finalCharacterNames = characterNames.length > 0
      ? characterNames
      : Array.from({ length: characterCount }, (_, index) => `Character ${index + 1}`);

    const toneText = tones.length > 0 ? tones.join(', ') : 'Dramatic';

    const technicalParts = [];
    if (imageStyle) technicalParts.push(`Visual Style: ${imageStyle}`);
    if (setting) technicalParts.push(`Setting: in ${setting}`);
    technicalParts.push(`Number of characters: ${characterCount}`);
    technicalParts.push(`Character names: ${finalCharacterNames.join(', ')}`);
    const technicalCueText = technicalParts.length > 0
      ? `${technicalParts.join('. ')}.`
      : '';

    const jsonSchemaGuide = `{
  "scene_number": 1,
  "timecode": "00:00 - 00:08",
  "scene_setting": "...",
  "style": "...",
  "camera": "...",
  "lighting": "...",
  "sound": "...",
  "character": [
    {
      "name": "...",
      "biology_and_anatomy": "...",
      "clothing_and_materials": "...",
      "accessories": "...",
      "action": "...",
      "expression": "..."
    }
  ],
  "narration": "...",
  "dialogue": [
    {
      "character": "...",
      "line": "..."
    }
  ]
}`;

    const characterConsistencyRules = `
CHARACTER CONTINUITY RULES (MANDATORY):
- Create standard character profiles starting from the first scene.
- If the same character appears in another scene, "biology_and_anatomy", "clothing_and_materials", and "accessories" must remain identical.
- Only modify dynamic context attributes: "action", "expression", and immediate environment effects.
- Never rename characters across scenes when referring to the same identity.`.trim();

    return `Write a video screenplay about "${mainTopic}". Objective: "${goal}" with a "${toneText}" narrative tone. Language: ${language}. Structure: Hook with "${hook}", core content lasting ~${duration}, concluding with CTA: "${cta}". ${technicalCueText} Divide into consecutive 8-second scenes. ${characterConsistencyRules} MANDATORY: Return ONLY valid JSON (no markdown, no explanations) where each scene is an independent JSON object separated by 1 blank line, NOT in an array []. Required schema:\n${jsonSchemaGuide}`.trim();
  };

  const buildCreateMainBatchInstruction = ({
    baseInstruction,
    startScene,
    endScene,
    totalScenes,
    totalDurationSeconds,
    previousSceneContext
  }) => {
    const safeStart = Math.max(1, Number(startScene) || 1);
    const safeEnd = Math.max(safeStart, Number(endScene) || safeStart);
    const safeTotalScenes = Math.max(safeEnd, Number(totalScenes) || safeEnd);
    const currentBatchSize = safeEnd - safeStart + 1;
    const totalDuration = Math.max(8, Number(totalDurationSeconds) || (safeTotalScenes * 8));

    const contextBlock = previousSceneContext
      ? `\nCONTEXT OF PREVIOUS SCENES (for visual continuity, DO NOT rewrite):\n${previousSceneContext}`
      : '';

    const sceneTimecodes = [];
    for (let s = safeStart; s <= safeEnd; s++) {
      const startSec = (s - 1) * 8;
      const endSec = s * 8;
      sceneTimecodes.push(`\n- Scene ${s}: ${formatSecondsToTimecode(startSec)} - ${formatSecondsToTimecode(endSec)}`);
    }
    const timecodeLinesBlock = sceneTimecodes.length > 0
      ? `\nMANDATORY TIMECODES FOR EACH SCENE:${sceneTimecodes.join('')}`
      : '';

    return [
      baseInstruction,
      '',
      'MANDATORY BATCH INSTRUCTIONS:',
      `- Generate EXACTLY ${currentBatchSize} new scenes, numbered from scene_number ${safeStart} to ${safeEnd}.`,
      `- Total scenes: ${safeTotalScenes}. Do not create scenes outside this range.`,
      '- Maintain strict visual continuity with preceding scenes.',
      '- Return ONLY the JSON objects of scenes in the requested range, with no conversational filler.'
    ].join('\n') + timecodeLinesBlock + contextBlock;
  };

  if (cpGenerateBtn && cpOutput) {
    cpGenerateBtn.addEventListener('click', () => {
      cpOutput.value = buildPromptFromCreateForm();
    });
  }

  if (cpGenerateGeminiBtn && cpOutput) {
    cpGenerateGeminiBtn.addEventListener('click', async () => {
      const baseInstruction = buildPromptFromCreateForm();
      cpOutput.value = baseInstruction;

      const totalDurationSeconds = parseDurationToSeconds(cpDuration?.value || '60s');
      const totalScenes = Math.max(1, Math.ceil(totalDurationSeconds / 8));
      const batchSize = 5;
      const totalBatches = Math.ceil(totalScenes / batchSize);

      if (cpPreview) {
        cpPreview.value = `Preparing to generate ${totalScenes} scenes (~${Math.round(totalDurationSeconds)}s) across ${totalBatches} batches, up to ${batchSize} scenes per batches...`;
      }
      if (cpIdeaPreview) {
        cpIdeaPreview.value = cpPreview ? cpPreview.value : 'Waiting for Gemini generation...';
      }
      chrome.storage.local.set({ geminiPreviewContent: cpPreview?.value || 'Waiting for Gemini generation...' }).catch(() => { });

      let geminiTabId = null;
      let combinedOutput = '';
      const sceneMap = new Map();

      try {
        for (let batchIndex = 0; batchIndex < totalBatches; batchIndex++) {
          const startScene = (batchIndex * batchSize) + 1;
          const endScene = Math.min(totalScenes, startScene + batchSize - 1);
          const currentBatchSize = endScene - startScene + 1;
          const runToken = generateGeminiRunToken('create-main');

          const previousSceneContext = combinedOutput
            ? combinedOutput.slice(-8000)
            : '';

          const batchInstruction = buildCreateMainBatchInstruction({
            baseInstruction,
            startScene,
            endScene,
            totalScenes,
            totalDurationSeconds,
            previousSceneContext
          });

          const previewWaiter = waitForGeminiPreviewByToken(runToken, 240000);
          let submitResult;

          if (cpPreview) {
            cpPreview.value = [
              `Running batch ${batchIndex + 1}/${totalBatches}...`,
              `Scene ${startScene}-${endScene}/${totalScenes}`,
              '',
              combinedOutput || '(no scene data yet)'
            ].join('\n');
          }

          if (!geminiTabId) {
            submitResult = await openGeminiTabWithPrompt(batchInstruction, { runToken });
            if (submitResult?.tabId) geminiTabId = submitResult.tabId;
          } else {
            submitResult = await sendPromptToGeminiTab(geminiTabId, batchInstruction, { runToken }, 30, 500);
          }

          if (!submitResult?.ok) {
            throw new Error(submitResult?.error || submitResult?.message || `Could not send batch ${batchIndex + 1} to Gemini.`);
          }

          const batchPayload = await previewWaiter;
          const batchPreviewText = String(batchPayload?.previewText || '').trim();
          if (!batchPreviewText) {
            throw new Error(`Batch ${batchIndex + 1} returned empty output.`);
          }

          const parsedScenes = parseSceneObjectsFromText(batchPreviewText);
          const rangedScenes = parsedScenes.filter(scene => {
            const num = Number(scene?.scene_number);
            return Number.isFinite(num) && num >= startScene && num <= endScene;
          });

          const scenesToUse = rangedScenes.length > 0 ? rangedScenes : parsedScenes;
          if (scenesToUse.length === 0) {
            throw new Error(`Batch ${batchIndex + 1} failed to parse valid scene JSON.`);
          }

          scenesToUse.forEach(scene => {
            const num = Number(scene?.scene_number);
            if (!Number.isFinite(num)) return;
            sceneMap.set(num, scene);
          });

          const orderedScenes = Array.from(sceneMap.entries())
            .sort((a, b) => a[0] - b[0])
            .map(([, scene]) => scene);

          combinedOutput = formatSceneObjects(orderedScenes);

          if (cpPreview) cpPreview.value = combinedOutput;
          if (cpIdeaPreview) cpIdeaPreview.value = combinedOutput;
          chrome.storage.local.set({ geminiPreviewContent: combinedOutput }).catch(() => { });

          // Brief delay to let UI stabilize before next batch.
          await new Promise(r => setTimeout(r, 600));
        }

        const doneMsg = `✓ Complete! Generated ${sceneMap.size}/${totalScenes} scenes across ${totalBatches} batches.`;
        alert(doneMsg);
      } catch (error) {
        const errorMsg = error?.message || String(error);
        if (cpPreview && !String(cpPreview.value || '').trim()) {
          cpPreview.value = combinedOutput;
        }
        if (cpIdeaPreview && !String(cpIdeaPreview.value || '').trim()) {
          cpIdeaPreview.value = combinedOutput;
        }
        alert(`Batch script generation stopped:\n\n${errorMsg}`);
      }
    });
  }

  const buildIdeaPromptInstruction = () => {
    const userIdea = String(cpIdeaInput?.value || '').trim();
    const durationHint = String(cpIdeaDuration?.value || '').trim();
    const styleHint = String(cpIdeaStyle?.value || '').trim();

    if (!userIdea) return '';

    const schemaGuide = `{
  "scene_number": 1,
  "timecode": "00:00 - 00:08",
  "scene_setting": "...",
  "style": "...",
  "camera": "...",
  "lighting": "...",
  "sound": "...",
  "character": [
    {
      "name": "...",
      "biology_and_anatomy": "...",
      "clothing_and_materials": "...",
      "accessories": "...",
      "action": "...",
      "expression": "..."
    }
  ],
  "narration": "...",
  "dialogue": [
    {
      "character": "...",
      "line": "..."
    }
  ]
}`;

    const durationLine = durationHint
      ? `- Target duration: ${durationHint}, divided into consecutive 8-second scenes.`
      : '- Optimal duration based on storyline, divided into consecutive 8-second scenes.';

    const styleLine = styleHint
      ? `- Preferred visual style: ${styleHint}.`
      : '- Choose a cinematic visual style fitting the creative premise.';

    const characterConsistencyLines = [
      '- Maintain character continuity across all scenes.',
      '- For identical characters: maintain consistent "biology_and_anatomy", "clothing_and_materials", and "accessories".',
      '- Only adjust dynamic attributes like action, expression, and environment interactions.',
      '- Never rename characters across scenes.'
    ].join('\n');

    return `User idea notes: "${userIdea}".
  You are an expert AI screenwriter and cinematic director. Based on user ideas, develop a full cinematic screenplay (setting, characters, action, camera, lighting, sound, narration, dialogue) structured by scenes.
  Mandatory Requirements:
${durationLine}
${styleLine}
- Each scene must have timecode format: 00:00 - 00:08, 00:08 - 00:16...
${characterConsistencyLines}
- Storyline must be logical, seamless, and rich in cinematic detail.
- Return ONLY valid JSON, NO markdown fences, NO explanatory chatter.
- Each prompt is an independent JSON object separated by 1 blank line, NOT in an array [].
- Object schema:
${schemaGuide}`.trim();
  };

  if (cpIdeaGenerateBtn) {
    cpIdeaGenerateBtn.addEventListener('click', async () => {
      const baseInstruction = buildIdeaPromptInstruction();
      if (!baseInstruction) {
        if (cpIdeaOutput) cpIdeaOutput.value = 'Please enter your idea / story notes before generating.';
        alert('Please enter your idea / story notes before generating.');
        return;
      }

      if (cpIdeaOutput) cpIdeaOutput.value = baseInstruction;

      const totalDurationSeconds = parseDurationToSeconds(cpIdeaDuration?.value || '60s');
      const totalScenes = Math.max(1, Math.ceil(totalDurationSeconds / 8));
      const batchSize = 5;
      const totalBatches = Math.ceil(totalScenes / batchSize);

      if (cpPreview) {
        cpPreview.value = `Preparing to generate ${totalScenes} scenes (~${Math.round(totalDurationSeconds)}s) across ${totalBatches} batches, up to ${batchSize} scenes per batches...`;
      }
      if (cpIdeaPreview) {
        cpIdeaPreview.value = cpPreview ? cpPreview.value : 'Waiting for Gemini generation...';
      }
      chrome.storage.local.set({ geminiPreviewContent: cpIdeaPreview?.value || 'Waiting for Gemini generation...' }).catch(() => { });

      let geminiTabId = null;
      let combinedOutput = '';
      const sceneMap = new Map();

      try {
        for (let batchIndex = 0; batchIndex < totalBatches; batchIndex++) {
          const startScene = (batchIndex * batchSize) + 1;
          const endScene = Math.min(totalScenes, startScene + batchSize - 1);
          const runToken = generateGeminiRunToken('create-idea');

          const previousSceneContext = combinedOutput
            ? combinedOutput.slice(-8000)
            : '';

          const batchInstruction = buildCreateMainBatchInstruction({
            baseInstruction,
            startScene,
            endScene,
            totalScenes,
            totalDurationSeconds,
            previousSceneContext
          });

          const previewWaiter = waitForGeminiPreviewByToken(runToken, 240000);
          let submitResult;

          if (cpIdeaPreview) {
            cpIdeaPreview.value = [
              `Running batch ${batchIndex + 1}/${totalBatches}...`,
              `Scene ${startScene}-${endScene}/${totalScenes}`,
              '',
              combinedOutput || '(no scene data yet)'
            ].join('\n');
          }

          if (!geminiTabId) {
            submitResult = await openGeminiTabWithPrompt(batchInstruction, { runToken });
            if (submitResult?.tabId) geminiTabId = submitResult.tabId;
          } else {
            submitResult = await sendPromptToGeminiTab(geminiTabId, batchInstruction, { runToken }, 30, 500);
          }

          if (!submitResult?.ok) {
            throw new Error(submitResult?.error || submitResult?.message || `Could not send batch ${batchIndex + 1} to Gemini.`);
          }

          const batchPayload = await previewWaiter;
          const batchPreviewText = String(batchPayload?.previewText || '').trim();
          if (!batchPreviewText) {
            throw new Error(`Batch ${batchIndex + 1} returned empty output.`);
          }

          const parsedScenes = parseSceneObjectsFromText(batchPreviewText);
          const rangedScenes = parsedScenes.filter(scene => {
            const num = Number(scene?.scene_number);
            return Number.isFinite(num) && num >= startScene && num <= endScene;
          });

          const scenesToUse = rangedScenes.length > 0 ? rangedScenes : parsedScenes;
          if (scenesToUse.length === 0) {
            throw new Error(`Batch ${batchIndex + 1} failed to parse valid scene JSON.`);
          }

          scenesToUse.forEach(scene => {
            const num = Number(scene?.scene_number);
            if (!Number.isFinite(num)) return;
            sceneMap.set(num, scene);
          });

          const orderedScenes = Array.from(sceneMap.entries())
            .sort((a, b) => a[0] - b[0])
            .map(([, scene]) => scene);

          combinedOutput = formatSceneObjects(orderedScenes);

          if (cpIdeaPreview) cpIdeaPreview.value = combinedOutput;
          if (cpPreview) cpPreview.value = combinedOutput;
          chrome.storage.local.set({ geminiPreviewContent: combinedOutput }).catch(() => { });

          await new Promise(r => setTimeout(r, 600));
        }

        alert(`✓ Complete! Generated ${sceneMap.size}/${totalScenes} scenes across ${totalBatches} batches.`);
      } catch (error) {
        const errorMsg = error?.message || String(error);
        if (cpIdeaPreview && !String(cpIdeaPreview.value || '').trim()) {
          cpIdeaPreview.value = combinedOutput;
        }
        if (cpPreview && !String(cpPreview.value || '').trim()) {
          cpPreview.value = combinedOutput;
        }
        alert(`Idea-to-script batch generation stopped:

${errorMsg}`);
      }
    });
  }

  // ==========================================
  // 4. RUN COMMAND & DISPATCH PROMPTS TO WEBPAGE
  // ==========================================
  const runBtns = document.querySelectorAll('.queue-card .btn-run');
  const btnClear = document.querySelector('.btn-clear');
  const queueBody = document.querySelector('.queue-body');
  const activeCount = document.querySelector('.active-count');

  const formatGroupCreatedAt = (dateObj) => {
    const date = dateObj instanceof Date ? dateObj : new Date();
    const pad = (num) => String(num).padStart(2, '0');
    const hours = pad(date.getHours());
    const minutes = pad(date.getMinutes());
    const seconds = pad(date.getSeconds());
    const day = pad(date.getDate());
    const month = pad(date.getMonth() + 1);
    const year = date.getFullYear();
    return `${hours}:${minutes}:${seconds} - ${day}/${month}/${year}`;
  };

  const restoreQueueFromSession = () => {
    if (!queueBody) return;
    chrome.storage.local.get(['veo_running_session'], (res) => {
      const session = res?.veo_running_session;
      if (!session || !Array.isArray(session.prompts) || session.prompts.length === 0) return;
      if (document.getElementById(session.groupId)) return; // already rendered

      let itemsHtml = '';
      const completedIconMarkup = `
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M20 6 9 17l-5-5"></path>
        </svg>
      `;

      let doneCount = 0;
      session.prompts.forEach((prompt, index) => {
        const truncatedPrompt = prompt.length > 50 ? prompt.substring(0, 50) + "..." : prompt;
        const itemInfo = session.itemStatuses?.[index] || {};
        const isDone = (itemInfo.status && (itemInfo.status.includes('Xong') || itemInfo.status.includes('Done'))) || (index < (session.currentIndex || 0) && session.status !== 'stopped');
        const isRunning = itemInfo.status && (itemInfo.status.includes('Running') || itemInfo.status.includes('Running') || itemInfo.status.includes('Entering') || itemInfo.status.includes('Preparing') || itemInfo.status.includes('Submitting') || itemInfo.status.includes('Rendering') || itemInfo.status.includes('Downloading') || itemInfo.status.includes('Running') || itemInfo.status.includes('Retry'));
        if (isDone) doneCount++;

        const itemClass = isDone ? 'queue-item completed' : (isRunning ? 'queue-item running' : 'queue-item');
        const leftContent = isDone ? `${completedIconMarkup}<span class="prompt-text">${truncatedPrompt}</span>` : `<span class="prompt-icon">📄</span><span class="prompt-text">${truncatedPrompt}</span>`;
        const statusText = itemInfo.status ? itemInfo.status.replace(/\s*\(?\d+%\)?/g, '').trim() : (isDone ? 'Done' : 'Pending');
        const statusColor = isDone ? '#4fd1c5' : (isRunning ? '#f59e0b' : '');
        const percent = itemInfo.percent !== undefined ? itemInfo.percent : (isDone ? 100 : 0);

        itemsHtml += `
          <div class="${itemClass}" id="item-${session.groupId}-${index}">
            <div class="queue-item-left">
              ${leftContent}
            </div>
            <div class="queue-item-right">
              <div class="progress-bar-small">
                <div class="progress-fill" style="width: ${percent}%;"></div>
              </div>
              <div class="status-text" style="${statusColor ? `color: ${statusColor};` : ''}">${statusText}</div>
            </div>
            ${percent > 0 ? `
              <div class="item-progress-container" style="width: 100%; height: 6px; background: rgba(255,255,255,0.1); border-radius: 3px; margin-top: 10px; overflow: hidden;">
                <div class="item-progress-fill" style="width: ${percent}%; height: 100%; background: ${percent >= 100 ? '#4fd1c5' : 'linear-gradient(90deg, #f59e0b, #4fd1c5)'};"></div>
              </div>
            ` : ''}
          </div>
        `;
      });

      const isGroupCompleted = session.status === 'completed' || (session.prompts.length > 0 && doneCount >= session.prompts.length);
      const isGroupStopped = session.status === 'stopped';
      const groupClass = isGroupCompleted ? 'queue-group completed' : (isGroupStopped ? 'queue-group stopped' : 'queue-group');
      const badgeText = isGroupCompleted ? 'Done' : (isGroupStopped ? 'Stopped' : 'Running');
      const badgeClass = isGroupCompleted ? 'badge-running badge-completed' : (isGroupStopped ? 'badge-running badge-stopped' : 'badge-running');

      const groupHtml = `
        <div class="${groupClass}" id="${session.groupId}">
          <div class="queue-group-header">
            <div class="queue-group-title">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"></polyline></svg>
              ${session.groupDisplayName || 'Automation'}
              <span class="${badgeClass}">${badgeText}</span>
            </div>
            <button class="btn-stop" style="${(isGroupCompleted || isGroupStopped) ? 'display: none;' : ''}">Stop</button>
          </div>
          <div class="queue-group-subtext">${doneCount}/${session.prompts.length} prompts</div>
          ${itemsHtml}
        </div>
      `;

      queueBody.insertAdjacentHTML('afterbegin', groupHtml);
      refreshActiveCount();
    });
  };

  const refreshActiveCount = () => {
    if (!activeCount) return;
    const runningGroups = document.querySelectorAll('.queue-group:not(.completed):not(.stopped)').length;
    activeCount.textContent = `${runningGroups} active`;
  };

  const markGroupStopped = (group) => {
    if (!group) return;

    group.classList.add('stopped');

    const allItems = group.querySelectorAll('.queue-item');
    const doneItems = group.querySelectorAll('.queue-item.completed').length;
    const totalCount = allItems.length;
    const subtext = group.querySelector('.queue-group-subtext');
    const badge = group.querySelector('.badge-running');
    const stopButton = group.querySelector('.btn-stop');

    allItems.forEach((item) => {
      if (item.classList.contains('completed')) return;
      item.classList.remove('running', 'submitted');
      item.classList.add('stopped');

      const statusText = item.querySelector('.status-text');
      if (statusText) {
        statusText.textContent = 'Stopped ⛔';
        statusText.style.color = '#ef4444';
      }
    });

    if (subtext) {
      subtext.textContent = `${doneItems}/${totalCount} prompts • Stopped`;
    }

    if (badge) {
      badge.textContent = 'Stopped';
      badge.classList.remove('badge-completed');
      badge.classList.add('badge-stopped');
    }

    if (stopButton) {
      stopButton.style.display = 'none';
    }

    refreshActiveCount();
  };

  const collectPromptImagePlanFromReview = (activeSection, promptCount) => {
    const plan = Array.from({ length: promptCount }, () => []);
    if (!activeSection) return plan;

    const reviewItems = activeSection.querySelectorAll('.review-card .review-list .review-item');
    if (!reviewItems || reviewItems.length === 0) return plan;

    reviewItems.forEach((item, index) => {
      const imageNames = Array.from(item.querySelectorAll('.review-info img[title]'))
        .map(img => (img.getAttribute('title') || '').trim())
        .filter(Boolean);
      if (index < plan.length) {
        plan[index] = imageNames;
      }
    });

    return plan;
  };

  if (btnClear && queueBody && activeCount) {
    btnClear.addEventListener('click', () => {
      queueBody.innerHTML = '';
      refreshActiveCount();
    });
  }

  if (queueBody) {
    queueBody.addEventListener('click', (event) => {
      const stopButton = event.target.closest('.btn-stop');
      if (stopButton) {
        event.preventDefault();
        event.stopPropagation();

        const group = stopButton.closest('.queue-group');
        if (!group || group.classList.contains('completed') || group.classList.contains('stopped')) {
          return;
        }

        markGroupStopped(group);

        const groupId = group.id;
        if (groupId && chrome?.tabs) {
          chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
            if (!tabs || !tabs[0]) return;
            chrome.tabs.sendMessage(tabs[0].id, {
              action: 'stop_automation',
              groupId
            }, () => {
              void chrome.runtime?.lastError;
            });
          });
        }
        return;
      }

      const header = event.target.closest('.queue-group-header');
      if (!header) return;

      const group = header.closest('.queue-group');
      if (!group) return;

      group.classList.toggle('collapsed');
    });
  }

  try {
    restoreQueueFromSession();
  } catch (e) {
    console.warn('[VEO Popup] Error restoring queue from session:', e);
  }
  refreshActiveCount();

  runBtns.forEach(btn => {
    btn.addEventListener('click', async () => {
      // 1. Extract prompts from input
      const activeSection = document.querySelector('.mode-section.active');
      const textArea = activeSection ? (activeSection.querySelector('.prompt-card textarea') || activeSection.querySelector('textarea')) : null;

      let promptList = [];
      let promptModes = []; // Mode array per prompt

      if (textArea && textArea.value.trim() !== "") {
        // Split text by empty lines
        promptList = textArea.value.split(/\n\s*\n/).map(p => p.trim()).filter(p => p !== "");
      }

      if (promptList.length === 0) {
        alert("Please enter at least 1 prompt!");
        return;
      }

      let masterPrompt = '';
      if (activeSection) {
        const mpEl = activeSection.querySelector('.master-prompt-input');
        if (mpEl && mpEl.value.trim()) {
          masterPrompt = mpEl.value.trim();
        }
      }

      if (typeof window.forceUpdatePreview === 'function' && textArea) {
        window.forceUpdatePreview(textArea);
      }

      const modeSelects = activeSection.querySelectorAll('.prompt-mode-select, select[id^="mode-"]');
      if (modeSelects.length > 0) {
        modeSelects.forEach(sel => promptModes.push(sel.value));
      } else {
        // Fallback to 8s default
        promptModes = promptList.map(() => '8s');
      }

      // Extract labels
      const allLabels = activeSection.querySelectorAll('label');

      let outputCount = "2";
      const outputDialSelect = activeSection.querySelector('.output-dial-select');
      if (outputDialSelect) {
        outputCount = outputDialSelect.value;
      } else {
        // fallback: search via label
        allLabels.forEach(label => {
          if (label.textContent.includes('Outputs per Prompt')) {
            const selectEl = label.nextElementSibling;
            if (selectEl && selectEl.tagName === 'SELECT') {
              outputCount = selectEl.value;
            }
          }
        });
      }

      let saveToFolder = 'veo-folder-1';
      const saveFolderInput = activeSection.querySelector('[id^="save-to-folder-"]');
      if (saveFolderInput) {
        const entered = String(saveFolderInput.value || '').trim();
        saveToFolder = entered || 'veo-folder-1';
      }

      let maxInputImagesPerPrompt = 3;

      // Extract visible select elements
      const selectsInSection = activeSection.querySelectorAll('select:not(.output-dial-select)');

      selectsInSection.forEach(sel => {
        // Find image selection dropdown
        if (sel.querySelector('option[value="1"]') && sel.querySelector('option[value="3"]')) {
          maxInputImagesPerPrompt = parseInt(sel.value, 10) || 3;
        }
      });

      // --- CONCURRENT PROMPT COUNT ---
      let concurrentCount = 2; // Default is 2

      let concurrentSource = activeSection;
      const activeModeConfig = document.querySelector('.mode-config.active');
      if (activeModeConfig && !activeSection.querySelector('.delay-wrapper')) {
        concurrentSource = activeModeConfig;
      }

      const dialWrap = concurrentSource.querySelector('.concurrent-dial-wrap');
      if (dialWrap) {
        // Check if current mode is locked to 1
        if (dialWrap.classList.contains('concurrent-locked')) {
          concurrentCount = 1;
        } else {
          // Get user selected count or fallback to default
          const hiddenInput = dialWrap.querySelector('input.concurrent-value');
          if (hiddenInput && hiddenInput.value) {
            concurrentCount = parseInt(hiddenInput.value, 10) || 2;
          }
        }
      }

      // 1. Extract Delay parameters
      let minDelay = 20;
      let maxDelay = 30;
      // Query delay inputs
      let delaySource = activeSection;
      const activeModeConfigForDelay = document.querySelector('.mode-config.active');
      if (activeModeConfigForDelay && !activeSection.querySelector('.delay-wrapper')) {
        delaySource = activeModeConfigForDelay;
      }
      const delayInputs = delaySource.querySelectorAll('.delay-wrapper input[type="number"]');
      if (delayInputs.length >= 2) {
        minDelay = parseInt(delayInputs[0].value) || 20;
        maxDelay = parseInt(delayInputs[1].value) || 30;
      }

      // 2. Query Default Mode from Setting Tab
      // ==========================================
      // Prioritize active mode in Control tab
      // ==========================================
      let selectedMode = "text-to-image"; // Default

      // Active tab ID
      if (activeSection) {
        selectedMode = activeSection.id;
      }

      if (!activeSection) {
        selectedMode = "text-to-image"; // Default value if tab not found
      }

      console.log("-> Selected mode for webpage:", selectedMode);

      let videoModel = 'veo-3.1-fast'; // Default
      let imageModel = 'nano-banana-2'; // Default
      let videoAspectRatio = '16:9'; // Variable for video
      let imageAspectRatio = '16:9'; // Variable for image
      let videoModeOption = '8 seconds'; // Default


      if (activeSection) {
        const labels = activeSection.querySelectorAll('label');
        labels.forEach(label => {
          if (label.textContent.includes('Default Video Mode Option')) {
            const sel = label.nextElementSibling;
            if (sel && sel.tagName === 'SELECT') {
              videoModeOption = sel.value;
            }
          }
        });
      }

      if (settingTab) {
        const allSelects = settingTab.querySelectorAll('select');
        allSelects.forEach(sel => {
          const label = sel.previousElementSibling;
          if (label) {
            // Video Model selector
            if (label.textContent.includes('Model') && !label.textContent.includes('Image')) {
              videoModel = sel.value;
            }
            // Image Model selector
            if (label.textContent.includes('Image Model')) {
              imageModel = sel.value;
            }

            // Video Aspect Ratio
            if (label.textContent.includes('Default Aspect Ratio') || label.textContent.includes('Video Aspect Ratio')) {
              videoAspectRatio = sel.value;
            }
            // Image Aspect Ratio
            if (label.textContent.includes('Image Aspect Ratio')) {
              imageAspectRatio = sel.value;
            }
      let maxRetries = 5;
      const settingTab = document.getElementById('setting-tab');
          }
        });
      }

      videoModel = normalizeVideoModelValue(videoModel);
      const maxRetriesInput = document.getElementById('max-retries');
      if (maxRetriesInput) {
        maxRetries = Math.max(1, Math.min(20, parseInt(maxRetriesInput.value, 10) || 5));
      }

    // 2. Update Queue UI for all prompts
      const groupId = "group-" + Date.now().toString().slice(-6);
      const groupCreatedAt = new Date();
      const groupDisplayName = `${promptList.length} prompts • ${formatGroupCreatedAt(groupCreatedAt)}`;

      let itemsHtml = '';
      promptList.forEach((promptText, index) => {
        // Truncate prompt for queue preview
        const shortPrompt = promptText.length > 40 ? promptText.substring(0, 40) + '...' : promptText;
        itemsHtml += `
          <div class="queue-item running" id="item-${groupId}-${index}">
            <div class="queue-item-row">
              <div class="queue-item-left">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-6.219-8.56"></path></svg>
                ${index + 1}. ${shortPrompt}
              </div>
              <div class="status-text">Pending</div>
            </div>
          </div>
        `;
      });

      const groupHtml = `
        <div class="queue-group" id="${groupId}">
          <div class="queue-group-header">
            <div class="queue-group-title">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"></polyline></svg>
              ${groupDisplayName}
              <span class="badge-running">Running</span>
            </div>
            <button class="btn-stop">Stop</button>
          </div>
          <div class="queue-group-subtext">0/${promptList.length} prompts</div>
          ${itemsHtml}
        </div>
      `;

      if (queueBody) {
        queueBody.insertAdjacentHTML('afterbegin', groupHtml);
        refreshActiveCount();
      }

      const serializedUploadedFiles = await serializeFilesForMessage(uploadedFilesRegistry[selectedMode] || []);
      const promptImagePlan = collectPromptImagePlanFromReview(activeSection, promptList.length);

      try {
        chrome.runtime.sendMessage({
          action: 'SET_DOWNLOAD_SUBFOLDER',
          folder: saveToFolder
        }).catch(() => { });
      } catch (e) { }

      const sessionPayload = {
        groupId: groupId,
        groupDisplayName: groupDisplayName,
        prompts: promptList,
        promptModes: promptModes,
        outputCount: outputCount,
        concurrentCount: concurrentCount,
        minDelay: minDelay,
        maxDelay: maxDelay,
        maxRetries: maxRetries,
        selectedMode: selectedMode,
        videoModel: videoModel,
        imageModel: imageModel,
        aspectRatio: selectedMode.includes('image') ? imageAspectRatio : videoAspectRatio,
        videoModeOption: videoModeOption,
        uploadedFiles: serializedUploadedFiles,
        promptImagePlan: promptImagePlan,
        maxInputImagesPerPrompt: maxInputImagesPerPrompt,
        saveToFolder: saveToFolder,
        masterPrompt: masterPrompt,
        currentIndex: 0,
        itemStatuses: {},
        status: 'running',
        startedAt: Date.now()
      };
      try {
        await chrome.storage.local.set({ veo_running_session: sessionPayload });
      } catch (e) {
        console.warn('[VEO Popup] Error persisting session:', e);
      }

      // 3. Dispatch prompts to webpage
      // 3. Dispatch prompts and output settings to webpage
      if (chrome && chrome.tabs) {
        chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
          if (tabs && tabs[0]) {
            chrome.tabs.sendMessage(tabs[0].id, {
              action: "run_automation",
              groupId: groupId,
              prompts: promptList,
              promptModes: promptModes,
              outputCount: outputCount,
              concurrentCount: concurrentCount,
              minDelay: minDelay,
              maxDelay: maxDelay,
              maxRetries: maxRetries,
              selectedMode: selectedMode,
              videoModel: videoModel,    // Pass video model
              imageModel: imageModel,     // Pass image model
              // aspectRatio: aspectRatio,
              aspectRatio: selectedMode.includes('image') ? imageAspectRatio : videoAspectRatio,
              videoModeOption: videoModeOption,
              uploadedFiles: serializedUploadedFiles,
              promptImagePlan: promptImagePlan,
              maxInputImagesPerPrompt: maxInputImagesPerPrompt,
              saveToFolder: saveToFolder,
              masterPrompt: masterPrompt
            }, (response) => {
              if (chrome.runtime.lastError) {
                alert("Could not connect to Google Flow. Please refresh (F5) the Flow tab and try again.");
              }
            });
          }
        });
      }
    });
  });

  // ==========================================
  // 5. PROMPT TXT FILE IMPORT
  // ==========================================
  const uploadBtns = document.querySelectorAll('.upload-btn');

  uploadBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      // Hidden file input
      const fileInput = document.createElement('input');
      fileInput.type = 'file';
      fileInput.accept = '.txt';

      // File change event listener
      fileInput.addEventListener('change', (event) => {
        const file = event.target.files[0];
        if (!file) return;

        // FileReader text parser
        const reader = new FileReader();
        reader.onload = (e) => {
          const content = e.target.result;
          // Populate textarea with file content
          const textArea = btn.closest('.prompt-card').querySelector('textarea');
          if (textArea) {
            textArea.value = content;
          }
        };
        reader.readAsText(file);
      });

      // Trigger system file picker
      fileInput.click();
    });
  });

  // ==========================================
  // 6. OPEN CHROME DOWNLOADS SETTINGS
  // ==========================================
  const downloadSettingBtn = document.querySelector('.download-settings-box .icon-btn');
  if (downloadSettingBtn) {
    downloadSettingBtn.addEventListener('click', () => {
      chrome.tabs.create({ url: 'chrome://settings/downloads' });
    });
  }

  // ==========================================
  // 7. MULTILINGUAL TRANSLATION SYSTEM
  // ==========================================
  // ==========================================
  // 7. MULTILINGUAL TRANSLATION SYSTEM
  // ==========================================
  const translations = {
    "zh": {
      "User Guide": "用户指南", "Control": "控制", "Setting": "设置",
      "Free plan": "免费计划", "Text to Video": "文本到视频",
      "Frame to Video": "帧到视频", "Ingredients to Video": "素材到视频",
      "Text to Image": "文本到图像", "Ingredients to Image": "素材到图像",
      "Concurrent Prompts": "并发提示", "Random Delay": "随机延迟",
      "Prompts": "提示词", "Outputs per Prompt": "每个提示的输出",
      "Save to folder": "保存到文件夹", "Image Processing Option": "图像处理选项",
      "Max Input Images per Prompt": "每个提示最大输入图像",
      "Auto-add character images": "自动添加角色图像", "Auto change file name": "自动更改文件名",
      "PROMPT QUEUE": "提示队列", "Clear": "清除", "Run": "运行",
      "Default Mode": "默认模式", "Model": "视频模型", "Image Model": "图像模型",
      "Default Aspect Ratio": "默认纵横比", "Default Video Mode Option": "默认视频模式选项",
      "Default Image ModeOption": "默认图像模式选项", "Max Retries on Failure": "失败时最大重试次数",
      "Auto Download Quality (Video)": "自动下载质量 (视频)", "Auto Download Quality (Image)": "自动下载质量 (图像)",
      "Language": "语言", "Download Settings": "下载设置",
      "Reset Defaults": "恢复默认值", "Save Settings": "保存设置"
    },
    "ko": {
      "User Guide": "사용자 가이드", "Control": "제어", "Setting": "설정",
      "Free plan": "무료 플랜", "Text to Video": "텍스트를 비디오로",
      "Frame to Video": "프레임을 비디오로", "Ingredients to Video": "재료를 비디오로",
      "Text to Image": "텍스트를 이미지로", "Ingredients to Image": "재료를 이미지로",
      "Concurrent Prompts": "동시 프롬프트", "Random Delay": "무작위 지연",
      "Prompts": "프롬프트", "Outputs per Prompt": "프롬프트 당 출력",
      "Save to folder": "폴더에 저장", "Image Processing Option": "이미지 처리 옵션",
      "Max Input Images per Prompt": "프롬프트 당 최대 입력 이미지",
      "Auto-add character images": "캐릭터 이미지 자동 추가", "Auto change file name": "파일 이름 자동 변경",
      "PROMPT QUEUE": "프롬프트 대기열", "Clear": "지우기", "Run": "실행",
      "Default Mode": "기본 모드", "Model": "비디오 모델", "Image Model": "이미지 모델",
      "Default Aspect Ratio": "기본 가로 세로 비율", "Default Video Mode Option": "기본 비디오 모드 옵션",
      "Default Image ModeOption": "기본 이미지 모드 옵션", "Max Retries on Failure": "실패 시 최대 재시도",
      "Auto Download Quality (Video)": "자동 다운로드 품질 (비디오)", "Auto Download Quality (Image)": "자동 다운로드 품질 (이미지)",
      "Language": "언어", "Download Settings": "다운로드 설정",
      "Reset Defaults": "기본값 복원", "Save Settings": "설정 저장"
    },
    "ja": {
      "User Guide": "ユーザーガイド", "Control": "コントロール", "Setting": "設定",
      "Free plan": "無料プラン", "Text to Video": "テキストから動画",
      "Frame to Video": "フレームから動画", "Ingredients to Video": "素材から動画",
      "Text to Image": "テキストから画像", "Ingredients to Image": "素材から画像",
      "Concurrent Prompts": "同時プロンプト", "Random Delay": "ランダム遅延",
      "Prompts": "プロンプト", "Outputs per Prompt": "プロンプトごとの出力",
      "Save to folder": "フォルダに保存", "Image Processing Option": "画像処理オプション",
      "Max Input Images per Prompt": "プロンプトごとの最大入力画像",
      "Auto-add character images": "キャラクター画像を自動追加", "Auto change file name": "ファイル名を自動変更",
      "PROMPT QUEUE": "プロンプトキュー", "Clear": "クリア", "Run": "実行",
      "Default Mode": "デフォルトモード", "Model": "動画モデル", "Image Model": "画像モデル",
      "Default Aspect Ratio": "デフォルトのアスペクト比", "Default Video Mode Option": "デフォルトの動画モードオプション",
      "Default Image ModeOption": "デフォルトの画像モードオプション", "Max Retries on Failure": "失敗時の最大再試行回数",
      "Auto Download Quality (Video)": "自動ダウンロード品質 (動画)", "Auto Download Quality (Image)": "自動ダウンロード品質 (画像)",
      "Language": "言語", "Download Settings": "ダウンロード設定",
      "Reset Defaults": "デフォルトに戻す", "Save Settings": "設定を保存"
    },
    "es": {
      "User Guide": "Guía del usuario", "Control": "Control", "Setting": "Ajustes",
      "Free plan": "Plan gratuito", "Text to Video": "Texto a video",
      "Frame to Video": "Fotograma a video", "Ingredients to Video": "Ingredientes a video",
      "Text to Image": "Texto a imagen", "Ingredients to Image": "Ingredientes a imagen",
      "Concurrent Prompts": "Prompts simultáneos", "Random Delay": "Retraso aleatorio",
      "Prompts": "Prompts", "Outputs per Prompt": "Salidas por prompt",
      "Save to folder": "Guardar en carpeta", "Image Processing Option": "Opción de procesamiento",
      "Max Input Images per Prompt": "Máx. imágenes por prompt",
      "Auto-add character images": "Añadir auto imágenes", "Auto change file name": "Cambio automático de archivo",
      "PROMPT QUEUE": "COLA DE PROMPTS", "Clear": "Borrar", "Run": "Ejecutar",
      "Default Mode": "Modo predeterminado", "Model": "Modelo de video", "Image Model": "Modelo de imagen",
      "Default Aspect Ratio": "Relación de aspecto", "Default Video Mode Option": "Opción de video predeterminada",
      "Default Image ModeOption": "Opción de imagen predeterminada", "Max Retries on Failure": "Máx. reintentos",
      "Auto Download Quality (Video)": "Calidad de descarga (Video)", "Auto Download Quality (Image)": "Calidad de descarga (Imagen)",
      "Language": "Idioma", "Download Settings": "Ajustes de descarga",
      "Reset Defaults": "Restablecer valores", "Save Settings": "Guardar ajustes"
    }
  };

    const infoTranslations = {
    en: {
      '.intro-card > h2': 'Office VEO Automation',
      '.intro-card > p': 'Quickly automate video, image, and prompt-cloning workflows on Google Flow.',
      '#intro-contact-title': 'Developer & Social Profiles',
      '.intro-contact-heading > span:last-child > small': 'Connect with ABID Ali',
      '.contact-author .intro-contact-copy small': 'Developer',
      '.contact-website .intro-contact-copy small': 'Website',
      '.contact-telegram .intro-contact-copy small': 'Twitter / X',
      '.contact-support .intro-contact-copy small': 'Instagram',
      '.contact-zalo .intro-contact-copy small': 'Facebook',
      '.contact-github .intro-contact-copy small': 'GitHub',
      '.intro-enter-label': 'Open main interface',
      '#guide-btn-open': '✦ Guide',
      '.header-author-label': 'Developer:',
      '.header-author-link': 'ABID Ali - abidalidev.com',
      '.user-guide-title': 'Detailed User Guide'
    }
  };

  function applyInfoLanguage(lang) {
    const selected = infoTranslations.en;
    Object.entries(selected).forEach(([selector, value]) => {
      const element = document.querySelector(selector);
      if (element) element.textContent = value;
    });
    const englishGuide = document.querySelector('.guide-content-en');
    if (englishGuide) englishGuide.hidden = false;

    updateHeaderNavigation(lang);
  }

  const originalTexts = new Map();

  function applyLanguage(lang) {
    const elements = document.querySelectorAll('.main-tab, .card-content, label, span, button, a, strong');

    elements.forEach(el => {
      el.childNodes.forEach(node => {
        if (node.nodeType === 3 && node.nodeValue.trim() !== '') {
          if (!originalTexts.has(node)) {
            originalTexts.set(node, node.nodeValue);
          }

          const original = originalTexts.get(node);
          const iconRegex = /^(⎘|⚙|⚡|🕒|📄|🗎|📁|👤|🖼️|📹|🍌|↺|📥|A文|👑|↻|✓|▷|☁️|☷)\s*/;
          const cleanKey = original.replace(iconRegex, '').trim();

          if (lang === 'en') {
            node.nodeValue = originalTexts.get(node);
          } else if (translations[lang] && translations[lang][cleanKey]) {
            const iconMatch = original.match(iconRegex);
            const icon = iconMatch ? iconMatch[0] : '';
            const spaceBefore = original.startsWith(' ') ? ' ' : '';
            const spaceAfter = original.endsWith(' ') ? ' ' : '';

            node.nodeValue = spaceBefore + icon + translations[lang][cleanKey] + spaceAfter;
          }
        }
      });
    });

    applyInfoLanguage(lang);
  }

  const langDropdowns = document.querySelectorAll('.lang-select');
  langDropdowns.forEach(dropdown => {
    dropdown.addEventListener('change', (e) => {
      const selectedLang = e.target.value;

      // Synchronize language selectors
      langDropdowns.forEach(dd => dd.value = selectedLang);

      // Run translations
      applyLanguage(selectedLang);

      // Update tab indicator
      const activeTab = document.querySelector('.main-tab.active');
      setTimeout(() => updateSlider(activeTab), 50);
    });
  });

  applyLanguage(document.querySelector('.header-lang-select')?.value || 'en');

});

// ==========================================
// 8. RESET DEFAULTS FUNCTIONALITY
// ==========================================
const btnReset = document.querySelector('.btn-reset');

// 1. Find all input fields on interface
const allInputs = document.querySelectorAll('input, select, textarea');
const defaultValues = new Map();

// 2. Snapshot default values on load
allInputs.forEach(input => {
  if (input.type === 'checkbox') {
    defaultValues.set(input, input.checked); // Save checked state
  } else {
    defaultValues.set(input, input.value); // Save string/number value
  }
});

// 3. Handle "Reset Defaults" click
if (btnReset) {
  btnReset.addEventListener('click', () => {
    allInputs.forEach(input => {
    // Helper
      if (input.type === 'checkbox') {
        input.checked = defaultValues.get(input);
      } else {
        input.value = defaultValues.get(input);
      }

      // Trigger change event for listeners
      input.dispatchEvent(new Event('change'));
    });

    // Temporary button visual feedback on reset
    const originalBg = btnReset.style.background;
    const originalColor = btnReset.style.color;
    btnReset.style.background = 'var(--primary)';
    btnReset.style.color = '#000';

    setTimeout(() => {
      btnReset.style.background = originalBg;
      btnReset.style.color = originalColor;
    }, 500);
  });
}

// ==========================================
// 9. MULTI-IMAGE UPLOAD (Drag & Drop, Remove, Add, Reorder)
// ==========================================
const uploadZones = document.querySelectorAll('.upload-zone');

uploadZones.forEach(zone => {
  let allFiles = [];
  let headerContainer = null;
  let previewContainer = zone.querySelector('.preview-container');
  const modeSection = zone.closest('.mode-section');
  const modeSectionId = modeSection ? modeSection.id : null;

  const syncRegistry = () => {
    if (!modeSectionId) return;
    uploadedFilesRegistry[modeSectionId] = [...allFiles];
  };

  if (!previewContainer) {
    previewContainer = document.createElement('div');
    previewContainer.className = 'preview-container';
    zone.appendChild(previewContainer);
  }

  // --- RENDER IMAGE CONTAINER ---
  const renderImages = (filesToRender) => {
    if (headerContainer) {
      headerContainer.querySelector('.preview-title').textContent = `Images (${filesToRender.length})`;
    }
    previewContainer.innerHTML = '';

    filesToRender.forEach((file, index) => {
      const item = document.createElement('div');
      item.className = 'preview-item';

      const img = document.createElement('img');
      img.src = URL.createObjectURL(file);
      img.title = file.name;

      const deleteIcon = document.createElement('div');
      deleteIcon.className = 'delete-icon';
      deleteIcon.innerHTML = '🗑️';
      deleteIcon.title = 'Remove this image';

      deleteIcon.addEventListener('click', (e) => {
        e.stopPropagation();
        const fileIndexInAllFiles = allFiles.findIndex(f => f.name === file.name && f.lastModified === file.lastModified);
        if (fileIndexInAllFiles !== -1) {
          allFiles.splice(fileIndexInAllFiles, 1);
          syncRegistry();
        }
        item.remove();

        if (headerContainer) {
          headerContainer.querySelector('.preview-title').textContent = `Images (${allFiles.length})`;
        }

        if (allFiles.length === 0) {
          zone.classList.remove('has-previews');
          if (headerContainer) headerContainer.remove();
          headerContainer = null;
          // Show upload guide text
          const guideP = zone.querySelector('p');
          if (guideP) guideP.style.display = 'block';
        } else {
          const sortSelect = headerContainer.querySelector('.preview-sort');
          if (sortSelect) sortSelect.dispatchEvent(new Event('change'));
        }
      });

      item.appendChild(img);
      item.appendChild(deleteIcon);
      previewContainer.appendChild(item);
    });
  };

  // --- CREATE OR UPDATE HEADER ---
  const createOrUpdateHeader = () => {
    if (headerContainer) return;

    const guideP = zone.querySelector('p');
    if (guideP) guideP.style.display = 'none'; // Hide guide text

    headerContainer = document.createElement('div');
    headerContainer.className = 'preview-header';

    const title = document.createElement('div');
    title.className = 'preview-title';
    title.textContent = `Images (${allFiles.length})`;

    const actionsWrapper = document.createElement('div');
    actionsWrapper.className = 'header-actions';

    const sortSelect = document.createElement('select');
    sortSelect.className = 'preview-sort';
    sortSelect.innerHTML = `
        <option value="custom">Custom Order</option>
        <option value="az">Name A&rarr;Z</option>
        <option value="za">Name Z&rarr;A</option>
        <option value="newest">Newest</option>
        <option value="oldest">Oldest</option>
      `;

    const addBtn = document.createElement('button');
    addBtn.className = 'btn-add-images';
    addBtn.textContent = 'Add images +';

    addBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const addFilesInput = document.createElement('input');
      addFilesInput.type = 'file';
      addFilesInput.multiple = true;
      addFilesInput.accept = 'image/png, image/jpeg, image/gif';
      addFilesInput.addEventListener('change', (e) => processFiles(e.target.files));
      addFilesInput.click();
    });

    sortSelect.addEventListener('change', (e) => {
      const sortType = e.target.value;
      let sortedFiles = [...allFiles];

      if (sortType === 'az') {
        sortedFiles.sort((a, b) => a.name.localeCompare(b.name));
      } else if (sortType === 'za') {
        sortedFiles.sort((a, b) => b.name.localeCompare(a.name));
      } else if (sortType === 'newest') {
        sortedFiles.sort((a, b) => b.lastModified - a.lastModified);
      } else if (sortType === 'oldest') {
        sortedFiles.sort((a, b) => a.lastModified - b.lastModified);
      }
      renderImages(sortedFiles);
    });

    actionsWrapper.appendChild(sortSelect);
    actionsWrapper.appendChild(addBtn);
    headerContainer.appendChild(title);
    headerContainer.appendChild(actionsWrapper);
    zone.insertBefore(headerContainer, previewContainer);
  };

  // --- SHARED FILE HANDLER (CLICK & DRAG-DROP) ---
  const processFiles = (fileList) => {
    const newFiles = Array.from(fileList).filter(file => file.type.startsWith('image/')); // Filter image files only
    if (newFiles.length === 0) return;

    allFiles = allFiles.concat(newFiles);
    syncRegistry();
    zone.classList.add('has-previews');
    createOrUpdateHeader();
    renderImages(allFiles);

    const ta = zone.closest('.mode-section').querySelector('.prompt-card textarea') || zone.closest('.mode-section').querySelector('textarea');
    if (ta) ta.dispatchEvent(new Event('input'));

    const sortSelect = headerContainer.querySelector('.preview-sort');
    if (sortSelect) sortSelect.value = 'custom';
  };

  // --- FILE PICKER CLICK EVENT ---
  zone.addEventListener('click', (e) => {
    if (e.target.closest('.preview-item') || e.target.closest('.preview-header')) return;
    const firstUploadInput = document.createElement('input');
    firstUploadInput.type = 'file';
    firstUploadInput.multiple = true;
    firstUploadInput.accept = 'image/png, image/jpeg, image/gif';
    firstUploadInput.addEventListener('change', (e) => processFiles(e.target.files));
    firstUploadInput.click();
  });

  // ==============================================
  // --- DRAG & DROP EVENTS ---
  // ==============================================

  // Drag over zone
  zone.addEventListener('dragover', (e) => {
    e.preventDefault(); // Prevent default to allow drop
    zone.classList.add('dragover');
  });

  // Drag leave zone
  zone.addEventListener('dragleave', (e) => {
    e.preventDefault();
    zone.classList.remove('dragover');
  });

  // Drop into zone
  zone.addEventListener('drop', (e) => {
    e.preventDefault();
    zone.classList.remove('dragover');

    // Extract files from dataTransfer
    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      processFiles(e.dataTransfer.files);
    }
  });

  zone.style.cursor = 'pointer';
});

document.addEventListener('DOMContentLoaded', () => {
  // Query delay inputs
  const allNumInputs = document.querySelectorAll('input[type="number"]');

  if (allNumInputs.length >= 2) {
    const minDelayInput = allNumInputs[allNumInputs.length - 2];
    const maxDelayInput = allNumInputs[allNumInputs.length - 1];

    // 1. Load saved values on popup open
    chrome.storage.local.get(['savedMinDelay', 'savedMaxDelay'], (result) => {
      if (result.savedMinDelay) minDelayInput.value = result.savedMinDelay;
      if (result.savedMaxDelay) maxDelayInput.value = result.savedMaxDelay;
    });

    // 2. Save values immediately on input
    const saveDelaySettings = () => {
      chrome.storage.local.set({
        savedMinDelay: minDelayInput.value,
        savedMaxDelay: maxDelayInput.value
      });
    };

    // Auto-save on input keystroke
    minDelayInput.addEventListener('input', saveDelaySettings);
    maxDelayInput.addEventListener('input', saveDelaySettings);
  }
});

// ==========================================
// LISTEN FOR PROGRESS AND UPDATE BARS
// ==========================================
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === "GEMINI_PREVIEW_UPDATE") {
    const previewBox = document.getElementById('cp-preview');
    const ideaPreviewBox = document.getElementById('cp-preview-idea');
    const cloneAudioPreviewBox = document.getElementById('cv-audio-prompt-preview');
    const previewText = String(request.previewText || '');
    const runToken = String(request.runToken || '');
    const isFinal = Boolean(request.isFinal);

    if (previewBox) {
      previewBox.value = previewText;
    }
    if (ideaPreviewBox) {
      ideaPreviewBox.value = previewText;
    }
    if (cloneAudioPreviewBox && runToken.startsWith('clone-audio')) {
      cloneAudioPreviewBox.value = previewText;
    }

    if (runToken && isFinal) {
      const pending = pendingGeminiPreviewResolvers.get(runToken);
      if (pending?.resolve) {
        pendingGeminiPreviewResolvers.delete(runToken);
        pending.resolve({ previewText, isFinal: true, runToken });
      }
    }

    chrome.storage.local.set({ geminiPreviewContent: previewText }).catch(() => { });
    return;
  }

  if (request.action === "UPDATE_QUEUE_STATUS") {
    let targetItem = null;

    if (request.groupId !== undefined && request.index !== undefined) {
      targetItem = document.getElementById(`item-${request.groupId}-${request.index}`);
    }

    if (!targetItem) {
      const queueItems = document.querySelectorAll('.queue-item');
      targetItem = queueItems[request.index];
    }

    if (targetItem) {
      const parentGroup = targetItem.closest('.queue-group');
      if (parentGroup && parentGroup.classList.contains('stopped')) {
        return;
      }

      const completedIconMarkup = `
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M20 6 9 17l-5-5"></path>
        </svg>
      `;

      // Query spinner icon
      const loadingIcon = targetItem.querySelector('svg') || targetItem.querySelector('i');
      const leftBlock = targetItem.querySelector('.queue-item-left');

      // 1. Update status text
      const statusText = targetItem.querySelector('.status-text');
      if (statusText) {
        // Hide % in status text
        const statusWithoutPercent = String(request.status || '')
          .replace(/\s*\(?\d+%\)?/g, '')
          .replace(/\s{2,}/g, ' ')
          .trim();
        statusText.textContent = statusWithoutPercent;

        const isDone = (request.status && (request.status.includes("Done") || request.status.includes("Xong"))) || (request.percent !== undefined && request.percent >= 100);
        const isRunning = (request.status && (request.status.includes("Running") || request.status.includes("Running") || request.status.includes("Rendering") || request.status.includes("Preparing") || request.status.includes("Entering") || request.status.includes("Attaching") || request.status.includes("Retrying") || request.status.includes("Uploading") || request.status.includes("Waiting"))) || (request.percent !== undefined && request.percent > 0 && request.percent < 100);

        if (isDone) {
          targetItem.classList.remove('running', 'submitted');
          targetItem.classList.add('completed');
          statusText.style.color = "#4fd1c5"; // Emerald color

          if (leftBlock) {
            const labelText = leftBlock.textContent.replace(/^\s*/, '');
            leftBlock.innerHTML = `${completedIconMarkup}${labelText}`;
          } else if (loadingIcon) {
            loadingIcon.style.animation = "none";
            loadingIcon.style.color = "#4fd1c5";
            loadingIcon.style.stroke = "#4fd1c5";
          }

        } else if (isRunning) {
          targetItem.classList.remove('completed');
          targetItem.classList.add('running');
          statusText.style.color = "#f59e0b"; // Amber color
        }
      }

      // 2. Render progress bar
      if (request.percent !== undefined) {
        let progContainer = targetItem.querySelector('.item-progress-container');

        // Create progress bar if not exists
        if (!progContainer) {
          targetItem.insertAdjacentHTML('beforeend', `
                        <div class="item-progress-container" style="width: 100%; height: 6px; background: rgba(255,255,255,0.1); border-radius: 3px; margin-top: 10px; overflow: hidden;">
                            <div class="item-progress-fill" style="width: 0%; height: 100%; background: linear-gradient(90deg, #f59e0b, #4fd1c5); transition: width 0.5s ease;"></div>
                        </div>
                    `);
          progContainer = targetItem.querySelector('.item-progress-container');
        }

        // Fill progress bar width
        const fill = targetItem.querySelector('.item-progress-fill');
        if (fill) {
          fill.style.width = request.percent + '%';
          // Green on 100% completion
          if (request.percent >= 100) {
            fill.style.background = "#4fd1c5";
          }
        }
      }

      // 3. Update group prompt progress counter
      if (parentGroup) {
        const allItems = parentGroup.querySelectorAll('.queue-item');
        const doneItems = parentGroup.querySelectorAll('.queue-item.completed');
        const subtext = parentGroup.querySelector('.queue-group-subtext');
        const badge = parentGroup.querySelector('.badge-running');
        const stopButton = parentGroup.querySelector('.btn-stop');
        const totalCount = allItems.length;
        const doneCount = doneItems.length;

        if (subtext) {
          subtext.textContent = `${doneCount}/${totalCount} prompts`;
        }

        if (totalCount > 0 && doneCount >= totalCount) {
          parentGroup.classList.add('completed');
          parentGroup.classList.remove('stopped');
          if (badge) {
            badge.textContent = 'Done';
            badge.classList.add('badge-completed');
            badge.classList.remove('badge-stopped');
          }
          if (stopButton) {
            stopButton.style.display = 'none';
          }
        } else {
          parentGroup.classList.remove('completed');
          if (badge) {
            badge.textContent = 'Running';
            badge.classList.remove('badge-completed');
            badge.classList.remove('badge-stopped');
          }
          if (stopButton) {
            stopButton.style.display = '';
          }
        }

        const activeCountEl = document.querySelector('.active-count');
        if (activeCountEl) {
          const runningGroups = document.querySelectorAll('.queue-group:not(.completed):not(.stopped)').length;
          activeCountEl.textContent = `${runningGroups} active`;
        }

        chrome.storage.local.get(['veo_running_session'], (res) => {
          if (res && res.veo_running_session && res.veo_running_session.groupId === request.groupId) {
            const sess = res.veo_running_session;
            sess.itemStatuses = sess.itemStatuses || {};
            sess.itemStatuses[request.index] = {
              status: request.status,
              percent: request.percent
            };
            if (request.status && (request.status.includes('Xong') || request.status.includes('Done'))) {
              sess.currentIndex = Math.max(sess.currentIndex || 0, request.index + 1);
            }
            if (parentGroup && parentGroup.classList.contains('completed')) {
              sess.status = 'completed';
            }
            chrome.storage.local.set({ veo_running_session: sess }).catch(() => { });
          }
        });
      }
    }
  }
});

// ==========================================
// SETTINGS STORAGE HANDLERS
// ==========================================
document.addEventListener('DOMContentLoaded', () => {
  // Query setting action buttons
  const btnSave = document.querySelector('.btn-save');
  const btnReset = document.querySelector('.btn-reset');
  const settingTab = document.getElementById('setting-tab');

  if (btnSave && settingTab) {

    // --- Collect all settings data ---
    const getAllSettings = () => {
      const selects = settingTab.querySelectorAll('select');
      const inputs = settingTab.querySelectorAll('input');

      let settings = {};

      // Collect select values
      selects.forEach((select, index) => {
        // Generate unique key
        const key = select.id || `setting_select_${index}`;
        settings[key] = select.value;
      });

      // Collect input values
      inputs.forEach((input, index) => {
        const key = input.id || `setting_input_${index}`;
        // Checkbox checked or input value
        settings[key] = input.type === 'checkbox' ? input.checked : input.value;
      });

      return settings;
    };

    // --- 1. LOAD SETTINGS ON POPUP LAUNCH ---
    chrome.storage.local.get(['veo_auto_settings'], (result) => {
      if (result.veo_auto_settings) {
        const savedSettings = result.veo_auto_settings;
        const selects = settingTab.querySelectorAll('select');
        const inputs = settingTab.querySelectorAll('input');

        selects.forEach((select, index) => {
          const key = select.id || `setting_select_${index}`;
          if (savedSettings[key] !== undefined) {
            select.value = savedSettings[key];

            if (select.selectedIndex === -1) {
              const label = select.previousElementSibling;
              if (label && label.textContent.includes('Video Model')) {
                select.value = normalizeVideoModelValue(savedSettings[key]);
              } else if (select.options.length > 0) {
                select.selectedIndex = 0;
              }
            }
          }
        });

        inputs.forEach((input, index) => {
          const key = input.id || `setting_input_${index}`;
          if (savedSettings[key] !== undefined) {
            if (input.type === 'checkbox') {
              input.checked = savedSettings[key];
            } else {
              input.value = savedSettings[key];
            }
          }
        });
      }
    });

    // --- 2. SAVE SETTINGS BUTTON ---
    btnSave.addEventListener('click', () => {

      // --- STEP 1: VISUAL FEEDBACK ---
      const originalText = btnSave.innerHTML;

      btnSave.innerHTML = "✅ Saved Successfully!";
      btnSave.style.setProperty('background-color', '#10b981', 'important');
      btnSave.style.setProperty('color', '#ffffff', 'important');
      btnSave.style.setProperty('border-color', '#10b981', 'important');

    // Helper
      setTimeout(() => {
        btnSave.innerHTML = originalText;
        btnSave.style.removeProperty('background-color');
        btnSave.style.removeProperty('color');
        btnSave.style.removeProperty('border-color');
      }, 2000);

      // --- STEP 2: PERSIST DATA ---
      try {
        const currentSettings = getAllSettings();
        chrome.storage.local.set({ veo_auto_settings: currentSettings }, () => {
          console.log("Saved settings to Chrome storage:", currentSettings);
        });
      } catch (error) {
        console.error("Error retrieving settings data:", error);
      }
    });

    // --- 3. RESET DEFAULTS BUTTON ---
    if (btnReset) {
      btnReset.addEventListener('click', () => {
        if (confirm("Are you sure you want to reset all settings to default?")) {
          // Clear Chrome storage
          chrome.storage.local.remove('veo_auto_settings', () => {
            // Reload popup to defaults
            window.location.reload();
          });
        }
      });
    }
  }
});

// ==========================================
// PROMPT PREVIEW CONTINUITY & REUSE
// ==========================================
document.addEventListener('DOMContentLoaded', () => {
  const promptTextAreas = document.querySelectorAll('.prompt-card textarea');

  const updatePreview = (textarea) => {
    const currentSection = textarea.closest('.mode-section');
    if (!currentSection) return;

    const reviewCard = currentSection.querySelector('.review-card');
    if (!reviewCard) return;

    const reviewList = reviewCard.querySelector('.review-list');
    const rawText = textarea.value;
    const prompts = rawText.split(/\n\s*\n/).map(p => p.trim()).filter(p => p !== "");

    if (prompts.length === 0) {
      reviewCard.style.display = 'none';
      reviewList.innerHTML = '';
      return;
    }

    reviewCard.style.display = 'block';

    // CHECK VIDEO OR IMAGE MODE
    const isImageMode = currentSection.id.includes('image');
    const opt1 = isImageMode ? 'Create new' : '8s';
    const opt2 = isImageMode ? 'Reuse' : 'Concat';
    const hintText = isImageMode ? 'new-image' : '8s';

    const toggleInput = currentSection.querySelector('.feature-toggle-card input[type="checkbox"]');
    const isAutoAddON = toggleInput ? toggleInput.checked : false;

    let maxInputImages = 3;
    const labelsInSection = currentSection.querySelectorAll('label');
    labelsInSection.forEach(label => {
      if (label.textContent.includes('Max Input Images per Prompt')) {
        const selectElement = label.nextElementSibling;
        if (selectElement && selectElement.tagName === 'SELECT') {
          const parsed = parseInt(selectElement.value, 10);
          if (Number.isFinite(parsed)) {
            maxInputImages = Math.max(1, Math.min(3, parsed));
          }
        }
      }
    });

    let frameProcessOpt = 'first-frame';
    if (currentSection.id === 'frame-to-video') {
      const selects = currentSection.querySelectorAll('select');
      selects.forEach(sel => { if (sel.innerHTML.includes('first-frame')) frameProcessOpt = sel.value; });
    }

    const oldSelects = reviewList.querySelectorAll('.prompt-mode-select');
    const savedModes = [];
    oldSelects.forEach(sel => savedModes[sel.dataset.index] = sel.value);

    const uploadedImages = [];
    const imageElements = currentSection.querySelectorAll('.preview-container img');
    imageElements.forEach(img => {
      let rawName = img.title || img.name || "";
      let cleanName = rawName.replace(/\.[^/.]+$/, "").toLowerCase();
      uploadedImages.push({ name: cleanName, originalName: rawName, src: img.src });
    });

    let html = '';
    let imgIndex = 0;

    prompts.forEach((prompt, index) => {
      const charCount = prompt.length;
      const shortPrompt = charCount > 40 ? prompt.substring(0, 40) + '...' : prompt;
      const lowerPrompt = prompt.toLowerCase();

      // Continuity rule: opt1 on terminal prompt
      let currentMode = opt1;
      if (index === prompts.length - 1) {
        currentMode = opt1;
      } else {
        currentMode = savedModes[index] || opt1;
      }

      // Continuity rule: reuse previous output
      const isReceivingChain = (index > 0 && savedModes[index - 1] === opt2);

      let finalImagesToRender = [];

      // TAB: FRAME TO VIDEO
      if (currentSection.id === 'frame-to-video') {
        if (isReceivingChain) {
          finalImagesToRender.push({ type: 'placeholder_last_frame' });
        } else {
          if (imgIndex < uploadedImages.length) { finalImagesToRender.push(uploadedImages[imgIndex]); imgIndex++; }
        }
        if (frameProcessOpt === 'first-last-frame' && imgIndex < uploadedImages.length && !isReceivingChain) {
          finalImagesToRender.push(uploadedImages[imgIndex]); imgIndex++;
        }
      }
      // TAB: INGREDIENTS TO VIDEO / IMAGE
      else if (currentSection.id === 'ingredients-to-video' || currentSection.id === 'ingredients-to-image') {
        if (isReceivingChain) {
          finalImagesToRender.push({ type: isImageMode ? 'placeholder_reuse' : 'placeholder_last_frame' });
        } else {
          uploadedImages.forEach(imgData => {
            if (!isAutoAddON || lowerPrompt.includes(imgData.name)) finalImagesToRender.push(imgData);
          });

          if (currentSection.id === 'ingredients-to-video') {
            finalImagesToRender = finalImagesToRender.slice(0, maxInputImages);
          }
        }
      }
      // TAB: TEXT TO VIDEO / IMAGE
      else if (currentSection.id === 'text-to-video' || currentSection.id === 'text-to-image') {
        if (isReceivingChain) {
          finalImagesToRender.push({ type: isImageMode ? 'placeholder_reuse' : 'placeholder_last_frame' });
        }
      }

      let matchedImagesHtml = '';
      let noMatchBanner = '';

      if (currentSection.id.includes('ingredients') && isAutoAddON && !isReceivingChain && finalImagesToRender.length === 0) {
        noMatchBanner = `
            <div style="width: 100%; display: flex; align-items: center; gap: 8px; padding: 6px 10px; background: rgba(255,255,255,0.03); border: 1px solid rgba(255,255,255,0.05); border-radius: 4px; margin-top: 4px; margin-bottom: 2px;">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#aaa" stroke-width="2"><path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z"></path><line x1="4" y1="22" x2="4" y2="15"></line></svg>
              <span style="color: #aaa; font-size: 11px;">No matching character images found</span>
            </div>`;
      }

      finalImagesToRender.forEach((imgData) => {
        if (imgData.type === 'placeholder_last_frame') {
          matchedImagesHtml += `
                <div style="position: relative; margin-right: 6px; width: 44px; height: 44px; border: 1px dashed #888; border-radius: 6px; display: flex; flex-direction: column; justify-content: center; align-items: center; background: rgba(255,255,255,0.02);">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#888" stroke-width="2" style="margin-bottom: 2px;"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect><circle cx="8.5" cy="8.5" r="1.5"></circle><polyline points="21 15 16 10 5 21"></polyline></svg>
                  <span style="color: #888; font-size: 8px; font-weight: bold; text-align: center; line-height: 1;">Last<br>Frame</span>
                </div>`;
        } else if (imgData.type === 'placeholder_reuse') {
          matchedImagesHtml += `
                <div style="position: relative; margin-right: 6px; width: 44px; height: 44px; border: 1px dashed #888; border-radius: 6px; display: flex; flex-direction: column; justify-content: center; align-items: center; background: rgba(255,255,255,0.02);">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#888" stroke-width="2" style="margin-bottom: 2px;"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect><circle cx="12" cy="10" r="3"></circle><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><polyline points="17 8 12 3 7 8"></polyline><line x1="12" y1="3" x2="12" y2="15"></line></svg>
                  <span style="color: #888; font-size: 8px; font-weight: bold; text-align: center; line-height: 1;">Reuse</span>
                </div>`;
        } else {
          matchedImagesHtml += `
                <div style="position: relative; margin-right: 6px; width: 44px; height: 44px;">
                  <img src="${imgData.src}" title="${imgData.originalName}" style="width: 100%; height: 100%; object-fit: cover; border-radius: 6px; border: 1px solid #4fd1c5; box-shadow: 0 2px 4px rgba(0,0,0,0.5);">
                </div>`;
        }
      });

      let imagePreviewContainer = matchedImagesHtml ? `<div style="display: flex; flex-wrap: wrap; margin-top: 6px;">${matchedImagesHtml}</div>` : '';

      // ========= AUDIO DROPDOWN =========
      // ========= AUDIO DROPDOWN =========
      let audioSelectHtml = '';
      if (currentSection.id === 'ingredients-to-video' && finalImagesToRender.length > 0) {
        audioSelectHtml = `
          <div style="position: relative; margin-top: 6px; width: 100%;">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#4fd1c5" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="position: absolute; left: 8px; top: 50%; transform: translateY(-50%); pointer-events: none;">
              <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"></polygon>
              <path d="M15.54 8.46a5 5 0 0 1 0 7.07"></path>
            </svg>
            <select class="prompt-audio-select" data-index="${index}" style="width: 100%; height: 30px; box-sizing: border-box; padding: 0 6px 0 26px; background: #1a1a1a; border: 1px solid #333; color: white; border-radius: 4px; outline: none; font-size: 11px; text-overflow: ellipsis;">
              <option value="">-- None --</option>
              <option value="audio_1">Audio Track 1</option>
            </select>
          </div>
        `;
      }
      // ======================================

      // BUILD DROPDOWN OPTIONS
      let selectOptions = '';
      if (index === prompts.length - 1) {
        selectOptions = `<option value="${opt1}" selected>${opt1}</option>`;
      } else {
        selectOptions = `<option value="${opt1}" ${currentMode === opt1 ? 'selected' : ''}>${opt1}</option><option value="${opt2}" ${currentMode === opt2 ? 'selected' : ''}>${opt2}</option>`;
      }

      let dynamicHint = currentMode === opt2
        ? (isImageMode ? 'Next prompt reuses this output' : 'Concat with next prompt')
        : `${charCount} characters - <span class="mode-label" style="color: #4fd1c5;">${hintText}</span>`;

      html += `
        <div class="review-item" style="display: flex; align-items: flex-start; gap: 12px; padding: 10px 12px; background: rgba(255,255,255,0.05); border: 1px solid rgba(255,255,255,0.1); border-radius: 6px; margin-bottom: 8px;">
          
          <div style="display: flex; flex-direction: column; width: 115px; flex-shrink: 0; margin-top: 2px;">
            <select class="prompt-mode-select" data-index="${index}" style="width: 100%; height: 30px; box-sizing: border-box; padding: 0 6px; background: #1a1a1a; border: 1px solid #333; color: white; border-radius: 4px; outline: none; font-size: 12px;">
              ${selectOptions}
            </select>
            ${audioSelectHtml}
          </div>

          <div class="review-info" style="display: flex; flex-direction: column; gap: 2px; flex: 1; overflow: hidden;">
            <strong style="color: #fff; font-size: 13px;">${index + 1}. ${shortPrompt}</strong>
            <span style="color: #888; font-size: 12px;">${dynamicHint}</span>
            ${noMatchBanner}
            ${imagePreviewContainer}
          </div>
          
        </div>
      `;
    });

    reviewList.innerHTML = html;

    const selects = reviewList.querySelectorAll('.prompt-mode-select');
    selects.forEach(sel => {
      sel.addEventListener('change', () => { updatePreview(textarea); });
    });
  };

  promptTextAreas.forEach(textarea => { textarea.addEventListener('input', () => updatePreview(textarea)); });

  const autoAddToggles = document.querySelectorAll('.feature-toggle-card input[type="checkbox"]');
  autoAddToggles.forEach(toggle => {
    toggle.addEventListener('change', (e) => {
      const currentSection = e.target.closest('.mode-section');
      const targetTa = currentSection ? (currentSection.querySelector('.prompt-card textarea') || currentSection.querySelector('textarea')) : null;
      if (targetTa) updatePreview(targetTa);
    });
  });

  const processOptionSelects = document.querySelectorAll('.mode-section select');
  processOptionSelects.forEach(select => {
    select.addEventListener('change', (e) => {
      const currentSection = e.target.closest('.mode-section');
      const targetTa = currentSection ? (currentSection.querySelector('.prompt-card textarea') || currentSection.querySelector('textarea')) : null;
      if (targetTa) updatePreview(targetTa);
    });
  });

  window.forceUpdatePreview = updatePreview;
});

//// ══════════════════════════════════════
  // DUAL RANGE SLIDER INIT - Random Delay
// ══════════════════════════════════════
// ══════════════════════════════════════
  // DUAL RANGE SLIDER INIT - Random Delay
// ══════════════════════════════════════
(function initDualRangeSliders() {
  const TRACK_MAX = 120;
  const MIN_FLOOR = 20;
  const GAP = 1;

  function setupWrapper(wrapper) {
    const inpMin = wrapper.querySelector('.delay-inputs-row input:first-child');
    const inpMax = wrapper.querySelector('.delay-inputs-row input:last-child');
    const rangeMin = wrapper.querySelector('.range-min');
    const rangeMax = wrapper.querySelector('.range-max');
    const fill = wrapper.querySelector('.slider-track-fill');

    if (!inpMin || !inpMax || !rangeMin || !rangeMax || !fill) return;

    function clamp(val, lo, hi) { return Math.max(lo, Math.min(hi, val)); }

    function updateFill() {
      const lo = parseInt(rangeMin.value);
      const hi = parseInt(rangeMax.value);
      const span = TRACK_MAX - MIN_FLOOR;
      const loPct = ((lo - MIN_FLOOR) / span * 100).toFixed(2);
      const hiPct = ((hi - MIN_FLOOR) / span * 100).toFixed(2);
      fill.style.left = loPct + '%';
      fill.style.width = (hiPct - loPct) + '%';
    }

    rangeMin.addEventListener('input', () => {
      let lo = clamp(parseInt(rangeMin.value), MIN_FLOOR, parseInt(rangeMax.value) - GAP);
      rangeMin.value = lo;
      inpMin.value = lo;
      updateFill();
    });

    rangeMax.addEventListener('input', () => {
      let hi = clamp(parseInt(rangeMax.value), parseInt(rangeMin.value) + GAP, TRACK_MAX);
      rangeMax.value = hi;
      inpMax.value = hi;
      updateFill();
    });

    inpMin.addEventListener('change', () => {
      let lo = clamp(parseInt(inpMin.value) || MIN_FLOOR, MIN_FLOOR, parseInt(inpMax.value) - GAP);
      inpMin.value = lo;
      rangeMin.value = lo;
      updateFill();
    });
    inpMin.addEventListener('blur', () => inpMin.dispatchEvent(new Event('change')));

    inpMax.addEventListener('change', () => {
      let hi = clamp(parseInt(inpMax.value) || parseInt(inpMin.value) + GAP, parseInt(inpMin.value) + GAP, TRACK_MAX);
      inpMax.value = hi;
      rangeMax.value = hi;
      updateFill();
    });
    inpMax.addEventListener('blur', () => inpMax.dispatchEvent(new Event('change')));

    updateFill();
    window.addEventListener('resize', updateFill);
  }

  function init() {
    document.querySelectorAll('.delay-wrapper').forEach(setupWrapper);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    requestAnimationFrame(init);
  }
})();

// ══════════════════════════════════════
// CONCURRENT PROMPTS — Semicircle Dial (1–6)
// ══════════════════════════════════════
(function initConcurrentDials() {
  const MIN = 1, MAX = 6;
  const START = -90, SWEEP = 180;
  const CX = 10, CY = 45, R = 32;

  function degToRad(d) { return d * Math.PI / 180; }

  function dotPos(v) {
    const pct = (v - MIN) / (MAX - MIN);
    const ang = degToRad(START + SWEEP * pct);
    return { x: CX + R * Math.cos(ang), y: CY + R * Math.sin(ang) };
  }

  function draw(canvas, value, locked) {
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, 72, 90);

    // Track arc
    ctx.beginPath();
    ctx.arc(CX, CY, R, degToRad(START), degToRad(START + SWEEP));
    ctx.strokeStyle = '#2a1f45';
    ctx.lineWidth = 3;
    ctx.stroke();

    for (let v = MIN; v <= MAX; v++) {
      const { x, y } = dotPos(v);
      const isActive = v === value;
      const isPast = v < value;

      // Dim when locked, gold when unlocked
      const activeColor = locked ? '#52525b' : '#d4af37';
      const activeFill = locked ? '#3a3a3a' : '#d4af37';
      const activeGlow = locked ? 'rgba(82,82,91,0.1)' : 'rgba(212,175,55,0.12)';
      const pastColor = locked ? '#3d2d5f' : '#7a5f2a';
      const pastFill = locked ? '#2a1f45' : '#5a4520';
      const inactiveText = locked ? '#3d2d5f' : '#52525b';
      const activeText = locked ? '#52525b' : '#0a0612';
      const pastText = locked ? '#3d2d5f' : '#c8a030';

      if (isActive) {
        ctx.beginPath();
        ctx.arc(x, y, 12, 0, Math.PI * 2);
        ctx.fillStyle = activeGlow;
        ctx.fill();
      }

      ctx.beginPath();
      ctx.arc(x, y, isActive ? 8 : 6, 0, Math.PI * 2);
      ctx.strokeStyle = isActive ? activeColor : (isPast ? pastColor : '#3d2d5f');
      ctx.lineWidth = isActive ? 2.5 : 1.5;
      ctx.stroke();

      ctx.beginPath();
      ctx.arc(x, y, isActive ? 4 : 3, 0, Math.PI * 2);
      ctx.fillStyle = isActive ? activeFill : (isPast ? pastFill : '#2a1f45');
      ctx.fill();

      ctx.fillStyle = isActive ? activeText : (isPast ? pastText : inactiveText);
      ctx.font = `bold ${isActive ? 8 : 7}px system-ui`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(v, x, y + 0.5);
    }
  }

  function buildNumbers(numsEl, value, onUpdate, locked) {
    numsEl.innerHTML = '';
    for (let v = MIN; v <= MAX; v++) {
      const span = document.createElement('span');
      const dist = Math.abs(v - value);
      span.className = 'concurrent-num' +
        (dist === 0 ? ' active' : dist === 1 ? ' near1' : dist === 2 ? ' near2' : '');
      span.style.fontSize = (dist === 0 ? 44 : dist === 1 ? 28 : dist === 2 ? 18 : 13) + 'px';

      // Dim color when locked
      if (locked) {
        span.style.opacity = '0.35';
        span.style.cursor = 'not-allowed';
      }

      span.textContent = v;
      span.dataset.v = v;
      if (!locked) {
        span.addEventListener('click', () => onUpdate(parseInt(span.dataset.v)));
      }
      numsEl.appendChild(span);
    }
  }

  function hitTest(canvas, mx, my) {
    let best = null, bestD = 999;
    for (let v = MIN; v <= MAX; v++) {
      const { x, y } = dotPos(v);
      const d = Math.hypot(mx - x, my - y);
      if (d < bestD) { bestD = d; best = v; }
    }
    return bestD < 20 ? best : null;
  }

  function setupDial(wrap) {
    const numsEl = wrap.querySelector('[data-concurrent-nums]');
    const canvas = wrap.querySelector('.concurrent-arc');
    const locked = numsEl.hasAttribute('data-concurrent-locked');
    if (!numsEl || !canvas) return;

    // Locked defaults to 1
    const defVal = parseInt(numsEl.getAttribute('data-default-val')) || 2;
    let value = locked ? 1 : defVal;

    function update(v) {
      if (locked) return;
      value = Math.max(MIN, Math.min(MAX, v));
      let hiddenInput = wrap.querySelector('input[type="hidden"].concurrent-value');
      if (!hiddenInput) {
        hiddenInput = document.createElement('input');
        hiddenInput.type = 'hidden';
        hiddenInput.className = 'concurrent-value';
        wrap.appendChild(hiddenInput);
      }
      hiddenInput.value = value;
      buildNumbers(numsEl, value, update, locked);
      draw(canvas, value, locked);
    }

    // Canvas events — skip if locked
    let dragging = false;
    canvas.addEventListener('mousedown', e => {
      if (locked) return;
      dragging = true;
      const r = canvas.getBoundingClientRect();
      const h = hitTest(canvas, e.clientX - r.left, e.clientY - r.top);
      if (h !== null) update(h);
    });
    canvas.addEventListener('mousemove', e => {
      if (!dragging) return;
      const r = canvas.getBoundingClientRect();
      const h = hitTest(canvas, e.clientX - r.left, e.clientY - r.top);
      if (h !== null) update(h);
    });
    window.addEventListener('mouseup', () => { dragging = false; });

    canvas.addEventListener('touchstart', e => {
      if (locked) return;
      e.preventDefault();
      const r = canvas.getBoundingClientRect();
      const t = e.touches[0];
      const h = hitTest(canvas, t.clientX - r.left, t.clientY - r.top);
      if (h !== null) update(h);
    }, { passive: false });
    canvas.addEventListener('touchmove', e => {
      if (locked) return;
      e.preventDefault();
      const r = canvas.getBoundingClientRect();
      const t = e.touches[0];
      const h = hitTest(canvas, t.clientX - r.left, t.clientY - r.top);
      if (h !== null) update(h);
    }, { passive: false });

    // Number swipe — skip if locked
    let swipeStartX = null, swipeVal = null;
    numsEl.addEventListener('mousedown', e => {
      if (locked) return;
      swipeStartX = e.clientX; swipeVal = value;
    });
    window.addEventListener('mousemove', e => {
      if (swipeStartX === null) return;
      const step = Math.round((e.clientX - swipeStartX) / 22);
      update(Math.max(MIN, Math.min(MAX, swipeVal + step)));
    });
    window.addEventListener('mouseup', () => { swipeStartX = null; swipeVal = null; });

    numsEl.addEventListener('touchstart', e => {
      if (locked) return;
      swipeStartX = e.touches[0].clientX; swipeVal = value;
    }, { passive: true });
    numsEl.addEventListener('touchmove', e => {
      if (swipeStartX === null) return;
      const step = Math.round((e.touches[0].clientX - swipeStartX) / 22);
      update(Math.max(MIN, Math.min(MAX, swipeVal + step)));
    }, { passive: true });
    numsEl.addEventListener('touchend', () => { swipeStartX = null; swipeVal = null; });

    // Initialize and create input.concurrent-value immediately
    update(value);

    // Canvas cursor
    canvas.style.cursor = locked ? 'not-allowed' : 'pointer';
  }

  function init() {
    document.querySelectorAll('.concurrent-dial-wrap').forEach(setupDial);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    requestAnimationFrame(init);
  }
})();

// ══════════════════════════════════════
// CONCURRENT PROMPTS — Semicircle Dial (1–6)
// ══════════════════════════════════════
// (function initConcurrentDials() {
//   const MIN = 1, MAX = 6;
//   const START = -90, SWEEP = 180;
//   const CX = 10, CY = 45, R = 32;

//   function degToRad(d) { return d * Math.PI / 180; }

//   function dotPos(v) {
//     const pct = (v - MIN) / (MAX - MIN);
//     const ang = degToRad(START + SWEEP * pct);
//     return { x: CX + R * Math.cos(ang), y: CY + R * Math.sin(ang) };
//   }

//   function draw(canvas, value) {
//     const ctx = canvas.getContext('2d');
//     ctx.clearRect(0, 0, 72, 90);

//     ctx.beginPath();
//     ctx.arc(CX, CY, R, degToRad(START), degToRad(START + SWEEP));
//     ctx.strokeStyle = '#2a1f45';
//     ctx.lineWidth = 3;
//     ctx.stroke();

//     for (let v = MIN; v <= MAX; v++) {
//       const { x, y } = dotPos(v);
//       const isActive = v === value;
//       const isPast = v < value;

//       if (isActive) {
//         ctx.beginPath();
//         ctx.arc(x, y, 12, 0, Math.PI * 2);
//         ctx.fillStyle = 'rgba(212,175,55,0.12)';
//         ctx.fill();
//       }

//       ctx.beginPath();
//       ctx.arc(x, y, isActive ? 8 : 6, 0, Math.PI * 2);
//       ctx.strokeStyle = isActive ? '#d4af37' : (isPast ? '#7a5f2a' : '#3d2d5f');
//       ctx.lineWidth = isActive ? 2.5 : 1.5;
//       ctx.stroke();

//       ctx.beginPath();
//       ctx.arc(x, y, isActive ? 4 : 3, 0, Math.PI * 2);
//       ctx.fillStyle = isActive ? '#d4af37' : (isPast ? '#5a4520' : '#2a1f45');
//       ctx.fill();

//       ctx.fillStyle = isActive ? '#0a0612' : (isPast ? '#c8a030' : '#52525b');
//       ctx.font = `bold ${isActive ? 8 : 7}px system-ui`;
//       ctx.textAlign = 'center';
//       ctx.textBaseline = 'middle';
//       ctx.fillText(v, x, y + 0.5);
//     }
//   }

//   function buildNumbers(numsEl, value, onUpdate) {
//     numsEl.innerHTML = '';
//     for (let v = MIN; v <= MAX; v++) {
//       const span = document.createElement('span');
//       const dist = Math.abs(v - value);
//       span.className = 'concurrent-num' +
//         (dist === 0 ? ' active' : dist === 1 ? ' near1' : dist === 2 ? ' near2' : '');
//       span.style.fontSize = (dist === 0 ? 44 : dist === 1 ? 28 : dist === 2 ? 18 : 13) + 'px';
//       span.textContent = v;
//       span.dataset.v = v;
//       span.addEventListener('click', () => onUpdate(parseInt(span.dataset.v)));
//       numsEl.appendChild(span);
//     }
//   }

//   function hitTest(canvas, mx, my) {
//     let best = null, bestD = 999;
//     for (let v = MIN; v <= MAX; v++) {
//       const { x, y } = dotPos(v);
//       const d = Math.hypot(mx - x, my - y);
//       if (d < bestD) { bestD = d; best = v; }
//     }
//     return bestD < 20 ? best : null;
//   }

//   function setupDial(wrap) {
//     const numsEl = wrap.querySelector('[data-concurrent-nums]');
//     const canvas = wrap.querySelector('.concurrent-arc');
//     const locked = numsEl.hasAttribute('data-concurrent-locked');
//     if (!numsEl || !canvas) return;

//     const defVal = parseInt(numsEl.getAttribute('data-default-val')) || 2;
    let value = locked ? 1 : defVal;

//     function update(v) {
//       if (locked) return;
//       value = Math.max(MIN, Math.min(MAX, v));
//       // Sync hidden input value for popup.js to read
//       let hiddenInput = wrap.querySelector('input[type="hidden"].concurrent-value');
//       if (!hiddenInput) {
//         hiddenInput = document.createElement('input');
//         hiddenInput.type = 'hidden';
//         hiddenInput.className = 'concurrent-value';
//         wrap.appendChild(hiddenInput);
//       }
//       hiddenInput.value = value;
//       buildNumbers(numsEl, value, update);
//       draw(canvas, value);
//     }

//     // Canvas events
//     let dragging = false;
//     canvas.addEventListener('mousedown', e => {
//       if (locked) return;
//       dragging = true;
//       const r = canvas.getBoundingClientRect();
//       const h = hitTest(canvas, e.clientX - r.left, e.clientY - r.top);
//       if (h !== null) update(h);
//     });
//     canvas.addEventListener('mousemove', e => {
//       if (!dragging) return;
//       const r = canvas.getBoundingClientRect();
//       const h = hitTest(canvas, e.clientX - r.left, e.clientY - r.top);
//       if (h !== null) update(h);
//     });
//     window.addEventListener('mouseup', () => { dragging = false; });

//     canvas.addEventListener('touchstart', e => {
//       if (locked) return;
//       e.preventDefault();
//       const r = canvas.getBoundingClientRect();
//       const t = e.touches[0];
//       const h = hitTest(canvas, t.clientX - r.left, t.clientY - r.top);
//       if (h !== null) update(h);
//     }, { passive: false });
//     canvas.addEventListener('touchmove', e => {
//       e.preventDefault();
//       const r = canvas.getBoundingClientRect();
//       const t = e.touches[0];
//       const h = hitTest(canvas, t.clientX - r.left, t.clientY - r.top);
//       if (h !== null) update(h);
//     }, { passive: false });

//     // Swipe on numbers
//     let swipeStartX = null, swipeVal = null;
//     numsEl.addEventListener('mousedown', e => { swipeStartX = e.clientX; swipeVal = value; });
//     window.addEventListener('mousemove', e => {
//       if (swipeStartX === null) return;
//       const step = Math.round((e.clientX - swipeStartX) / 22);
//       update(Math.max(MIN, Math.min(MAX, swipeVal + step)));
//     });
//     window.addEventListener('mouseup', () => { swipeStartX = null; swipeVal = null; });

//     numsEl.addEventListener('touchstart', e => {
//       swipeStartX = e.touches[0].clientX; swipeVal = value;
//     }, { passive: true });
//     numsEl.addEventListener('touchmove', e => {
//       if (swipeStartX === null) return;
//       const step = Math.round((e.touches[0].clientX - swipeStartX) / 22);
//       update(Math.max(MIN, Math.min(MAX, swipeVal + step)));
//     }, { passive: true });
//     numsEl.addEventListener('touchend', () => { swipeStartX = null; swipeVal = null; });

//     update(value);
//   }

//   function init() {
//     document.querySelectorAll('.concurrent-dial-wrap').forEach(setupDial);
//   }

//   if (document.readyState === 'loading') {
//     document.addEventListener('DOMContentLoaded', init);
//   } else {
//     requestAnimationFrame(init);
//   }
// })();

(function initOutputDials() {
  'use strict';

  const VALS = [1, 2, 3, 4];
  const TAU = Math.PI * 2;

  // Arc: starts bottom-left (225°), sweeps 270° clockwise to bottom-right
  const START_ANG = (Math.PI / 180) * 225;
  const SWEEP = (Math.PI / 180) * 270;

  function valToAngle(val) {
    const idx = VALS.indexOf(val);
    if (idx < 0) return START_ANG;
    return START_ANG + (idx / (VALS.length - 1)) * SWEEP;
  }

  function drawDial(canvas, val, locked) {
    const DPR = window.devicePixelRatio || 1;
    const SIZE = 130;
    canvas.width = SIZE * DPR;
    canvas.height = SIZE * DPR;
    canvas.style.width = SIZE + 'px';
    canvas.style.height = SIZE + 'px';

    const ctx = canvas.getContext('2d');
    ctx.scale(DPR, DPR);
    ctx.clearRect(0, 0, SIZE, SIZE);

    const cx = SIZE / 2;
    const cy = SIZE / 2;
    const R = SIZE / 2 - 18;

    const activeAng = valToAngle(val);
    const goldColor = '#fbbf24';
    const trackColor = '#2a1a4a';

    // 1. Outer decorative ring
    ctx.beginPath();
    ctx.arc(cx, cy, R + 8, START_ANG, START_ANG + SWEEP);
    ctx.strokeStyle = 'rgba(61, 45, 95, 0.4)';
    ctx.lineWidth = 1;
    ctx.stroke();

    // 2. Main background track
    ctx.beginPath();
    ctx.arc(cx, cy, R, START_ANG, START_ANG + SWEEP);
    ctx.strokeStyle = trackColor;
    ctx.lineWidth = 6;
    ctx.lineCap = 'round';
    ctx.stroke();

    // 3. Dial markers
    for (let i = 0; i < VALS.length; i++) {
      const markerAng = valToAngle(VALS[i]);
      const mX = cx + R * Math.cos(markerAng);
      const mY = cy + R * Math.sin(markerAng);

      ctx.beginPath();
      ctx.arc(mX, mY, 4.5, 0, TAU);
      ctx.fillStyle = '#0a0612';
      ctx.fill();

      ctx.beginPath();
      ctx.arc(mX, mY, 4.5, 0, TAU);
      // Active value styling
      ctx.strokeStyle = (VALS[i] <= val) ? goldColor : '#4a3076';
      ctx.lineWidth = 2.5;
      ctx.stroke();
    }

    // 4. Active arc glow
    if (val > VALS[0] || val === VALS[0]) {
      ctx.beginPath();
      ctx.arc(cx, cy, R, START_ANG, activeAng);
      // Warm gold styling
      ctx.strokeStyle = goldColor;
      ctx.lineWidth = 6;
      ctx.lineCap = 'round';

      // Glow effect
      ctx.shadowBlur = 12;
      ctx.shadowColor = goldColor;
      ctx.stroke();
      ctx.shadowBlur = 0;
    }

    // Helper
    const dotX = cx + R * Math.cos(activeAng);
    const dotY = cy + R * Math.sin(activeAng);

    // Display dial handle
    ctx.beginPath();
    ctx.arc(dotX, dotY, 14, 0, TAU);
    ctx.fillStyle = 'rgba(251, 191, 36, 0.25)';
    ctx.fill();

    ctx.beginPath();
    ctx.arc(dotX, dotY, 7.5, 0, TAU);
    ctx.fillStyle = goldColor;
    ctx.shadowBlur = 8;
    ctx.shadowColor = goldColor;
    ctx.fill();
    ctx.shadowBlur = 0;

    ctx.beginPath();
    ctx.arc(dotX, dotY, 3, 0, TAU);
    ctx.fillStyle = '#0a0612';
    ctx.fill();
  }

  function setupDial(card) {
    const canvas = card.querySelector('.output-dial-canvas');
    const numEl = card.querySelector('.output-dial-num');
    const select = card.querySelector('.output-dial-select');
    const btns = card.querySelectorAll('.output-val-btn');
    const locked = card.classList.contains('output-dial-locked');

    if (!canvas || !numEl || !select) return;

    let val = parseInt(select.value) || 2;

    function commit(newVal) {
      if (locked) return;
      val = newVal;
      select.value = String(val);
      select.dispatchEvent(new Event('change', { bubbles: true }));
      numEl.textContent = String(val);
      drawDial(canvas, val, locked);
      btns.forEach(b => {
        const bv = parseInt(b.getAttribute('data-val'));
        b.classList.toggle('dial-btn-active', bv === val);
      });
    }

    // Init render
    numEl.textContent = String(val);
    drawDial(canvas, val, locked);
    btns.forEach(b => {
      const bv = parseInt(b.getAttribute('data-val'));
      b.classList.toggle('dial-btn-active', bv === val);
    });

    if (locked) {
      canvas.style.opacity = '0.45';
      // numEl.style.opacity = '0.45';
      return;
    }

    // ── Button clicks ─────────────────────
    btns.forEach(btn => {
      btn.addEventListener('click', () => {
        commit(parseInt(btn.getAttribute('data-val')));
      });
    });

    // ── Canvas arc drag ───────────────────
    let dragging = false;

    function angleFromPointer(ex, ey) {
      const r = canvas.getBoundingClientRect();
      const dx = (ex - r.left) - r.width / 2;
      const dy = (ey - r.top) - r.height / 2;
      return Math.atan2(dy, dx);
    }

    function valFromAngle(ang) {
      let rel = ang - START_ANG;
      // normalise to [0, TAU)
      while (rel < 0) rel += TAU;
      while (rel > TAU) rel -= TAU;
      if (rel > SWEEP + 0.25) return val; // click outside arc gap
      const frac = Math.min(1, rel / SWEEP);
      const idx = Math.round(frac * (VALS.length - 1));
      return VALS[Math.max(0, Math.min(VALS.length - 1, idx))];
    }

    canvas.addEventListener('mousedown', e => {
      dragging = true;
      const v = valFromAngle(angleFromPointer(e.clientX, e.clientY));
      commit(v);
    });
    window.addEventListener('mousemove', e => {
      if (!dragging) return;
      const v = valFromAngle(angleFromPointer(e.clientX, e.clientY));
      if (v !== val) commit(v);
    });
    window.addEventListener('mouseup', () => { dragging = false; });

    canvas.addEventListener('touchstart', e => {
      e.preventDefault();
      const t = e.touches[0];
      commit(valFromAngle(angleFromPointer(t.clientX, t.clientY)));
    }, { passive: false });
    canvas.addEventListener('touchmove', e => {
      e.preventDefault();
      const t = e.touches[0];
      const v = valFromAngle(angleFromPointer(t.clientX, t.clientY));
      if (v !== val) commit(v);
    }, { passive: false });

    // ── Swipe on number ───────────────────
    let swipeStartX = null, swipeStartVal = val;
    numEl.style.cursor = 'ew-resize';
    numEl.addEventListener('mousedown', e => {
      swipeStartX = e.clientX;
      swipeStartVal = val;
    });
    window.addEventListener('mousemove', e => {
      if (swipeStartX === null || e.buttons !== 1) return;
      const step = Math.round((e.clientX - swipeStartX) / 28);
      const newIdx = Math.max(0, Math.min(VALS.length - 1, VALS.indexOf(swipeStartVal) + step));
      if (VALS[newIdx] !== val) commit(VALS[newIdx]);
    });
    window.addEventListener('mouseup', () => { swipeStartX = null; });
  }

  // ── User Guide modal & Back arrow ─────
  function initGuideModal() {
    const openBtn = document.getElementById('guide-btn-open');
    const closeBtn = document.getElementById('guide-btn-close');
    const backdrop = document.getElementById('guide-backdrop');
    const modal = document.getElementById('user-guide-modal');
    const backBtn = document.getElementById('back-to-intro-btn');
    const introScreen = document.getElementById('intro-screen');

    if (openBtn && modal) openBtn.addEventListener('click', () => modal.classList.remove('hidden'));
    if (closeBtn && modal) closeBtn.addEventListener('click', () => modal.classList.add('hidden'));
    if (backdrop && modal) backdrop.addEventListener('click', () => modal.classList.add('hidden'));

    document.addEventListener('keydown', e => {
      if (e.key === 'Escape' && modal && !modal.classList.contains('hidden'))
        modal.classList.add('hidden');
    });

    if (backBtn && introScreen)
      backBtn.addEventListener('click', () => {
        const introIsOpen = !introScreen.classList.contains('hidden');
        introScreen.classList.toggle('hidden', introIsOpen);
        document.body.classList.toggle('intro-open', !introIsOpen);
        document.dispatchEvent(new Event('intro-view-change'));
      });
  }

  function init() {
    document.querySelectorAll('.output-dial-card').forEach(setupDial);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => { init(); initGuideModal(); });
  } else {
    requestAnimationFrame(() => { init(); initGuideModal(); });
  }
})();
