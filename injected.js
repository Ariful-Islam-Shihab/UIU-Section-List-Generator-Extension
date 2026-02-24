(() => {
  const SOURCE = 'UCAM_PDF_EXT';

  try {
    window.postMessage(
      {
        source: SOURCE,
        type: 'INTERCEPTOR_READY',
        payload: { timestamp: new Date().toISOString() },
      },
      '*'
    );
  } catch {
    // ignore
  }

  function normalizeUrl(urlLike) {
    try {
      return new URL(urlLike, window.location.href).toString();
    } catch {
      return String(urlLike || '');
    }
  }

  function isSectionsUrl(url) {
    return typeof url === 'string' && (url.includes('/sections') || url.includes('sections?'));
  }

  function postSections(url, data) {
    try {
      window.postMessage(
        {
          source: SOURCE,
          type: 'SECTIONS_RESPONSE',
          payload: {
            url,
            data,
            timestamp: new Date().toISOString(),
          },
        },
        '*'
      );
    } catch {
      // ignore
    }
  }

  // Intercept fetch
  const originalFetch = window.fetch;
  if (typeof originalFetch === 'function') {
    window.fetch = async function (...args) {
      const input = args[0];
      const url = normalizeUrl(typeof input === 'string' ? input : input && input.url);

      const response = await originalFetch.apply(this, args);

      try {
        if (isSectionsUrl(url)) {
          const clone = response.clone();
          clone
            .json()
            .then((data) => postSections(url, data))
            .catch(() => {
              // Not JSON or unreadable
            });
        }
      } catch {
        // ignore
      }

      return response;
    };
  }

  // Intercept XHR
  const originalOpen = XMLHttpRequest.prototype.open;
  const originalSend = XMLHttpRequest.prototype.send;

  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    this.__ucam_sections_url = normalizeUrl(url);
    return originalOpen.call(this, method, url, ...rest);
  };

  XMLHttpRequest.prototype.send = function (...args) {
    this.addEventListener(
      'load',
      function () {
        try {
          const url = this.__ucam_sections_url;
          if (!isSectionsUrl(url)) return;

          const text = this.responseText;
          if (typeof text !== 'string' || !text) return;

          const data = JSON.parse(text);
          postSections(url, data);
        } catch {
          // ignore
        }
      },
      { once: true }
    );

    return originalSend.apply(this, args);
  };
})();
