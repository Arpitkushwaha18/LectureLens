# B2 corrected foundation

The original B2 report is superseded by `PHASE_B3.md`. The original implementation
incorrectly added student accounts. That feature and its tests have been removed.

The original report recorded no hosted migration push. Inspection found no active
credential files and no local linked-project reference. The initial, unpushed migration
was revised to contain only four resource tables, with no account-related objects.
Hosted migration history has not yet been independently verified. If the old migration
was applied outside this session, stop: do not push the revised file or drop remote objects.
Review a forward-only migration and retention plan first.

Shared YouTube resources remain canonical and independent of student identity.
Documents remain private by default; no document access or upload API is implemented.
Direct anon/authenticated database access is denied. All MVP resource access goes through
controlled backend APIs; the Supabase secret remains server-only.
