# UCam Sections PDF Generator (Chrome Extension)

A Chrome **Manifest V3** extension that captures the UCam “sections” API response from the portal and generates a **PDF section list** from it.

It supports:
- Department selection in the popup
- Course selection (generate PDF for only selected courses)
- Landscape A4 PDF with a table layout
- PDF filename format: **`{dept_title}_section list.pdf`**

> Note: This extension is tailored to a UCam-style payload shaped like `data.courses[].sections[]`.

---

## How it works (high level)

- **`injected.js`** runs in the page’s **MAIN** world and intercepts **`fetch`** and **`XMLHttpRequest`**.
- When it detects a URL that looks like a **sections** endpoint, it clones/parses the JSON and forwards it via `window.postMessage`.
- **`content.js`** receives that message and forwards it to the extension.
- **`background.js`** stores captures in `chrome.storage.local`.
- **`popup.js`** reads the latest capture, lets you pick department + courses, and generates the PDF using **jsPDF**.

---

## Install (Load unpacked)

1. Open Chrome and go to `chrome://extensions`.
2. Enable **Developer mode**.
3. Click **Load unpacked**.
4. Select this folder (the one containing `manifest.json`).

---

## Usage

1. Open the UCam portal in Chrome.
2. Navigate to the page/action that loads the **sections list** (the request URL usually contains `sections`).
3. Click the extension icon to open the popup.
4. In the popup:
   - Select a **Department**.
   - Select the **Courses** you want included.
   - Click **Generate PDF**.

The downloaded file will be named like:
- `CSE_section list.pdf`

---

## Columns in the PDF

The generated table includes:
- Course Code
- Course Title
- Section
- Faculty
- Schedule (one entry per line, e.g. `Saturday: 08:30 - 09:50`)
- Class Room

---

## Clear / Refresh

- **Refresh**: reloads data from local storage.
- **Clear All Data**: removes all stored captures from `chrome.storage.local`.

---

## Troubleshooting

### No departments / no courses shown
- Make sure you visited the portal page that triggers the sections request.
- Try reloading the portal page, then open the popup again.
- Ensure the request URL contains `sections` (the interceptor only saves “sections” responses).

### PDF downloads are blocked
- Ensure the extension has the **Downloads** permission.
- Chrome may block downloads if you have restrictive download settings.

### Data looks outdated
- The popup uses the **latest capture** for the selected department.
- Use **Refresh** or revisit the portal page to generate a new capture.

---

## Privacy

- Captured data is stored **locally** in `chrome.storage.local`.
- The extension does not intentionally send captured data to any external server.

---

## Project files

- `manifest.json` – MV3 manifest, permissions
- `background.js` – service worker storage + MAIN world script registration
- `content.js` – receives messages from page and forwards to the extension
- `injected.js` – intercepts `fetch`/XHR in MAIN world
- `popup.html` – popup UI
- `popup.js` – UI + extraction + PDF generation
- `lib/jspdf.umd.min.js` – jsPDF library
