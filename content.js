console.log('UCam Sections PDF Generator content script loaded');

// Listen for messages from the injected script (page context)
window.addEventListener('message', (event) => {
  if (event.source !== window) return;
  if (!event.data || event.data.source !== 'UCAM_PDF_EXT') return;

  if (event.data.type === 'INTERCEPTOR_READY') {
    console.log('UCam interceptor ready', event.data.payload);
    return;
  }

  if (event.data.type !== 'SECTIONS_RESPONSE') return;

  const payload = event.data.payload || {};
  if (!payload.url || typeof payload.data === 'undefined') return;

  console.log('UCam captured sections response:', payload.url);

  chrome.runtime.sendMessage({
    type: 'CAPTURE_SECTIONS',
    url: payload.url,
    data: payload.data,
    timestamp: payload.timestamp,
  });
});