(() => {
  if (window.__veoAutomationPageBridgeInstalled) return;
  window.__veoAutomationPageBridgeInstalled = true;

  const REQUEST_EVENT = 'VEO_AUTOMATION_TRIGGER_RUN_REACT';
  const RESULT_EVENT = 'VEO_AUTOMATION_TRIGGER_RUN_REACT_RESULT';
  const ROOT = document.documentElement;

  function isVisible(element) {
    if (!element) return false;
    const rect = element.getBoundingClientRect();
    const style = window.getComputedStyle(element);
    return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
  }

  function isEnabled(element) {
    if (!element || !isVisible(element)) return false;
    if (element.disabled) return false;
    if ((element.getAttribute('aria-disabled') || '').toLowerCase() === 'true') return false;
    if ((element.getAttribute('disabled') || '').toLowerCase() === 'true') return false;
    return true;
  }

  function getReactProps(element) {
    if (!element) return null;

    const directKey = Object.keys(element).find(key =>
      key.startsWith('__reactProps$') || key.startsWith('__reactEventHandlers$')
    );
    if (directKey && element[directKey]) return element[directKey];

    const fiberKey = Object.keys(element).find(key =>
      key.startsWith('__reactFiber$') || key.startsWith('__reactInternalInstance$')
    );
    let fiber = fiberKey ? element[fiberKey] : null;
    for (let depth = 0; depth < 8 && fiber; depth++) {
      if (fiber.memoizedProps) return fiber.memoizedProps;
      fiber = fiber.return;
    }

    return null;
  }

  function makeHandlerEvent(type, target) {
    const rect = target.getBoundingClientRect();
    const clientX = Math.round(rect.left + rect.width / 2);
    const clientY = Math.round(rect.top + rect.height / 2);
    const event = {
      type,
      target,
      currentTarget: target,
      bubbles: true,
      cancelable: true,
      defaultPrevented: false,
      isTrusted: true,
      button: 0,
      buttons: type.toLowerCase().includes('up') ? 0 : 1,
      detail: type === 'click' ? 1 : 0,
      pointerId: 1,
      pointerType: 'mouse',
      isPrimary: true,
      clientX,
      clientY,
      screenX: clientX,
      screenY: clientY,
      pageX: clientX + window.scrollX,
      pageY: clientY + window.scrollY,
      timeStamp: Date.now(),
      view: window,
      srcElement: target,
      relatedTarget: null,
      nativeEvent: {
        type,
        target,
        currentTarget: target,
        srcElement: target,
        isTrusted: true,
        button: 0,
        buttons: type.toLowerCase().includes('up') ? 0 : 1,
        detail: type === 'click' ? 1 : 0,
        pointerId: 1,
        pointerType: 'mouse',
        isPrimary: true,
        clientX,
        clientY,
        screenX: clientX,
        screenY: clientY,
        pageX: clientX + window.scrollX,
        pageY: clientY + window.scrollY,
        timeStamp: Date.now(),
        view: window
      },
      isDefaultPrevented() { return !!event.defaultPrevented; },
      isPropagationStopped() { return !!event.propagationStopped; },
      preventDefault() { event.defaultPrevented = true; },
      stopPropagation() { event.propagationStopped = true; },
      persist() { }
    };
    return event;
  }

  function callReactHandlersOn(element) {
    const props = getReactProps(element);
    if (!props) return 0;

    const handlerNames = [
      'onPointerDownCapture',
      'onMouseDownCapture',
      'onPointerDown',
      'onMouseDown',
      'onPointerUp',
      'onMouseUp',
      'onClickCapture',
      'onClick'
    ];

    let called = 0;
    for (const name of handlerNames) {
      const handler = props[name];
      if (typeof handler !== 'function') continue;
      const eventType = name.toLowerCase().includes('click')
        ? 'click'
        : name.toLowerCase().includes('pointer')
          ? (name.toLowerCase().includes('up') ? 'pointerup' : 'pointerdown')
          : (name.toLowerCase().includes('up') ? 'mouseup' : 'mousedown');
      try {
        handler(makeHandlerEvent(eventType, element));
        called += 1;
      } catch (error) {
        console.warn('[veo-page-bridge] React handler failed:', name, error);
      }
    }

    return called;
  }

  function collectReactHandlerTargets(button, icon) {
    const targets = [];
    const add = (element) => {
      if (!element || targets.includes(element)) return;
      targets.push(element);
    };

    add(icon);
    add(button);

    let node = button;
    for (let depth = 0; depth < 8 && node && node !== document.body; depth++) {
      if (getReactProps(node)) add(node);
      node = node.parentElement;
    }

    return targets.filter(Boolean);
  }

  function dispatchMouseSequence(element) {
    if (!element) return false;
    const rect = element.getBoundingClientRect();
    const clientX = Math.round(rect.left + rect.width / 2);
    const clientY = Math.round(rect.top + rect.height / 2);

    const sequence = [
      ['pointerover', PointerEvent, { buttons: 0 }],
      ['pointerenter', PointerEvent, { buttons: 0 }],
      ['mouseover', MouseEvent, { buttons: 0 }],
      ['mouseenter', MouseEvent, { buttons: 0 }],
      ['pointerdown', PointerEvent, { buttons: 1 }],
      ['mousedown', MouseEvent, { buttons: 1 }],
      ['pointerup', PointerEvent, { buttons: 0 }],
      ['mouseup', MouseEvent, { buttons: 0 }],
      ['click', MouseEvent, { buttons: 0 }]
    ];

    for (const [type, EventCtor, extra] of sequence) {
      try {
        element.dispatchEvent(new EventCtor(type, {
          bubbles: true,
          cancelable: true,
          composed: true,
          pointerType: EventCtor === PointerEvent ? 'mouse' : undefined,
          isPrimary: EventCtor === PointerEvent ? true : undefined,
          button: 0,
          clientX,
          clientY,
          view: window,
          ...extra
        }));
      } catch (error) { }
    }

    try { element.click(); } catch (error) { }
    return true;
  }

  function triggerRunButton(button) {
    if (!isEnabled(button)) return { ok: false, called: 0, clicked: false };

    const icon = Array.from(button.querySelectorAll('i, .google-symbols, .material-icons'))
      .find(el => String(el.textContent || '').trim() === 'arrow_forward');
    const targets = collectReactHandlerTargets(button, icon);

    let called = 0;
    for (const target of targets) {
      called += callReactHandlersOn(target);
    }

    const clicked = dispatchMouseSequence(button);
    if (icon) dispatchMouseSequence(icon);

    return { ok: called > 0 || clicked, called, clicked };
  }

  document.addEventListener(REQUEST_EVENT, () => {
    const token = ROOT.getAttribute('data-veo-run-token') || '';
    const safeToken = token.replace(/[^a-zA-Z0-9_-]/g, '');
    const button = safeToken
      ? document.querySelector(`[data-veo-run-button-token="${safeToken}"]`)
      : null;

    const result = triggerRunButton(button);
    ROOT.setAttribute('data-veo-run-result-token', token);
    ROOT.setAttribute('data-veo-run-result-ok', result.ok ? '1' : '0');
    ROOT.setAttribute('data-veo-run-result-called', String(result.called || 0));
    ROOT.setAttribute('data-veo-run-result-clicked', result.clicked ? '1' : '0');
    document.dispatchEvent(new Event(RESULT_EVENT));
  });

  // Programmatic file upload interception
  let pendingFileInput = null;
  const originalInputClick = HTMLInputElement.prototype.click;
  HTMLInputElement.prototype.click = function (...args) {
    if (this.type === 'file' && document.documentElement.getAttribute('data-veo-active') === 'true') {
      pendingFileInput = this;
      return;
    }
    return originalInputClick.apply(this, args);
  };

  document.addEventListener('VEO_UPLOAD_FILE_DATA', (event) => {
    const data = event.detail;
    if (!data || !pendingFileInput) return;
    try {
      const { base64, filename, mimeType } = data;
      let rawBase64 = base64 || '';
      if (rawBase64.includes(',')) {
        rawBase64 = rawBase64.split(',')[1];
      }
      const binaryStr = atob(rawBase64);
      const byteNumbers = new Array(binaryStr.length);
      for (let i = 0; i < binaryStr.length; i++) {
        byteNumbers[i] = binaryStr.charCodeAt(i);
      }
      const byteArray = new Uint8Array(byteNumbers);
      const blob = new Blob([byteArray], { type: mimeType || 'image/png' });
      const file = new File([blob], filename || 'uploaded_image.png', { type: mimeType || 'image/png' });
      const dataTransfer = new DataTransfer();
      dataTransfer.items.add(file);
      pendingFileInput.files = dataTransfer.files;
      pendingFileInput.dispatchEvent(new Event('change', { bubbles: true }));
      pendingFileInput.dispatchEvent(new Event('input', { bubbles: true }));
    } catch (err) {
      console.warn('[veo-page-bridge] Error setting file data:', err);
    } finally {
      pendingFileInput = null;
    }
  });
})();
