# B1.5 workspace review

- `workspace-desktop.png`: central workspace at a 1440px Chromium iframe viewport.
- `workspace-mobile.png`: central workspace at a 390px Chromium iframe viewport.

Screenshots document the local-only frontend preview, not generated learning results.
The existing API health indicator reads offline because no backend was started for this review.

Viewport checks at 320, 360, 390, 430, 768, 1024 and 1440px found no horizontal overflow,
including a selected file with a long filename. Source labels and Continue retain 44px-or-larger
touch targets. These are Chromium checks, not physical-device or Safari verification.

Browser interaction checks exercised source switching, URL validation, multi-output selection,
Continue confirmation, clipboard-denied fallback with input focus, PDF drag/drop,
XLSX/XLS/CSV picker change events, file removal, invalid
replacement and rejection of multi-file drops. File fixtures are synthetic technical metadata
tests, not academic resources; no file contents are processed or uploaded.

File extension/MIME checks use browser metadata only and do not establish content safety.
Selections remain in memory, with no persistence on reload. The 10 MiB local file limit and
unrecognized-MIME rejection are preview safeguards, not a backend upload policy.
