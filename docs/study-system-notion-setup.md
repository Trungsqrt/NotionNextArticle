# Private "Study System" — Notion Workspace Setup & Data Model Guide

This guide documents the private Notion databases that back the **Private Study Room** repository layer (`lib/study/`).

> **Security Isolation Rule (Mandatory)**
> Create a **separate Notion Internal Integration** (for example, `Study System Private`) with its own token (`STUDY_NOTION_TOKEN`).
> - Connect `Study System Private` **ONLY** to the 5 databases inside your private **Study System** page.
> - **NEVER** connect your public Knowledge Hub integration (`NOTION_TOKEN`) to the **Study System** page or any of its 5 databases.
> - **NEVER** connect `Study System Private` to your public Articles or Translation Mapping databases.

---

## 1. Step-by-Step Manual Notion Setup

1. **Create a Private Workspace Area**:
   - In Notion, create a private top-level page named **`Study System`** (do not publish to web; keep workspace sharing restricted to yourself).
2. **Create a Dedicated Notion Integration**:
   - Open [Notion My Integrations](https://www.notion.so/my-integrations) → **New integration**.
   - Name it **`Study System Private`**.
   - Capabilities: enable **Read content**, **Update content**, and **Insert content**.
   - Copy the Internal Integration Secret and set it as `STUDY_NOTION_TOKEN` in `.env.local` (and Vercel Production Environment Variables).
3. **Create the 5 Databases Inside `Study System`**:
   - Create 5 full-page or inline databases inside `Study System` using the exact property names and types listed in Section 2:
     1. `Study Users`
     2. `Exam Collections`
     3. `Question Bank`
     4. `FSRS Card State`
     5. `Review Events`
4. **Connect the Integration**:
   - Open the parent **`Study System`** page → top-right `•••` menu → **Connections** → select **`Study System Private`** (connecting the parent page grants access to all 5 child databases).
   - Double-check that your public Knowledge Hub integration is **not** listed under Connections.
5. **Copy Database IDs into `.env.local`**:
   - Open each database as a full page and copy its 32-character database ID from the URL (`https://www.notion.so/<workspace>/<DATABASE_ID>?v=...`).
   - Populate:
     ```env
     STUDY_NOTION_TOKEN=secret_...
     STUDY_NOTION_USERS_DB_ID=...
     STUDY_NOTION_EXAMS_DB_ID=...
     STUDY_NOTION_QUESTIONS_DB_ID=...
     STUDY_NOTION_CARD_STATES_DB_ID=...
     STUDY_NOTION_REVIEW_EVENTS_DB_ID=...
     ```

---

## 2. Exact Notion Database Schemas

### 2.1 `Study Users` (`STUDY_NOTION_USERS_DB_ID`)

| Property Name | Notion Type | Notes |
|---|---|---|
| `User ID` | `title` | Stable logical ID (e.g. `usr-001`), never tied to a Notion page UUID |
| `Username` | `rich_text` | Unique normalized lowercase username (`3-64` chars: `a-z`, `0-9`, `.`, `_`, `-`) |
| `Access Key Hash` | `rich_text` | Salted modern KDF hash (`scrypt$<saltHex>$<hashHex>` or `$argon2id$...`). Plaintext & unsalted SHA-256 are rejected by schema validation. |
| `Hash Version` | `select` | Options: `scrypt-v1`, `argon2id-v1` |
| `Role` | `select` | Options: `admin`, `student` |
| `Status` | `select` | Options: `active`, `revoked` |
| `Credential Version` | `number` | Integer `>= 1`. Increment to immediately revoke all active sessions for this user. |
| `Created At` | `date` | ISO-8601 timestamp |
| `Updated At` | `date` | ISO-8601 timestamp |

### 2.2 `Exam Collections` (`STUDY_NOTION_EXAMS_DB_ID`)

| Property Name | Notion Type | Notes |
|---|---|---|
| `Exam ID` | `title` | Stable logical ID (e.g. `csa-core-01`) |
| `Title` | `rich_text` | Display title (max 200 chars) |
| `Description` | `rich_text` | Short overview (max 2,000 chars) |
| `Certification Category` | `select` | e.g. `CSA`, `CAD`, `CIS-ITSM` |
| `Question Count` | `number` | Integer `>= 0` |
| `Status` | `select` | Options: `published`, `draft` |

### 2.3 `Question Bank` (`STUDY_NOTION_QUESTIONS_DB_ID`)

| Property Name | Notion Type | Notes |
|---|---|---|
| `Question ID` | `title` | Stable logical ID preserved across updates (e.g. `csa-q-0001`) |
| `Exam ID` | `rich_text` | References `Exam Collections.Exam ID` |
| `Question Text` | `rich_text` | Prompt text (auto-chunked across 2,000-char rich_text elements if long) |
| `Question Type` | `select` | Options: `single_choice`, `multi_select` |
| `Options JSON` | `rich_text` | Ordered JSON array: `[{"id":"A","text":"...","feedback":"..."}, ...]` |
| `Correct Option IDs` | `rich_text` | JSON array of option IDs: `["A"]` or `["A","C"]` (server-only) |
| `Explanation` | `rich_text` | Full explanation revealed only after grading (auto-chunked if >2,000 chars) |
| `Image Refs JSON` | `rich_text` | Optional JSON array: `[{"id":"img-1","alt":"...","caption":"..."}]` |
| `Topic` | `select` | Blueprint domain / topic name |
| `Status` | `select` | Options: `published`, `draft`, `retired` |
| `Content Version` | `number` | Integer `>= 1`; increment on content edits |

### 2.4 `FSRS Card State` (`STUDY_NOTION_CARD_STATES_DB_ID`)

| Property Name | Notion Type | Notes |
|---|---|---|
| `State Key` | `title` | Composite key `${userId}::${questionId}` for deterministic lookup |
| `User ID` | `rich_text` | References `Study Users.User ID` |
| `Question ID` | `rich_text` | References `Question Bank.Question ID` |
| `Card State JSON` | `rich_text` | Serialized `FsrsCardSnapshot` JSON (`state`, `due`, `stability`, `difficulty`, `elapsedDays`, `scheduledDays`, `reps`, `lapses`, `lastReview`, `learningSteps`) |
| `Due` | `date` | Top-level indexed due timestamp (enables Notion `date.on_or_before` queries) |
| `Last Review` | `date` | Top-level timestamp of most recent review (nullable for `New` cards) |
| `Revision` | `number` | Monotonic integer `>= 1` used for optimistic concurrency checks |
| `Scheduler Version` | `rich_text` | e.g. `ts-fsrs-5` |
| `Parameters Version` | `rich_text` | e.g. `fsrs-default-v1` |
| `Updated At` | `date` | ISO-8601 timestamp |

### 2.5 `Review Events` (`STUDY_NOTION_REVIEW_EVENTS_DB_ID`)

| Property Name | Notion Type | Notes |
|---|---|---|
| `Event ID` | `title` | Unique idempotency key (e.g. UUID / ULID) |
| `User ID` | `rich_text` | References `Study Users.User ID` |
| `Question ID` | `rich_text` | References `Question Bank.Question ID` |
| `Reviewed At` | `date` | ISO-8601 timestamp |
| `Rating` | `select` | Options: `again`, `hard`, `good`, `easy` |
| `Previous State JSON` | `rich_text` | `FsrsCardSnapshot` before review |
| `Resulting State JSON` | `rich_text` | `FsrsCardSnapshot` after review |
| `Scheduler Version` | `rich_text` | e.g. `ts-fsrs-5` |
| `Parameters Version` | `rich_text` | e.g. `fsrs-default-v1` |

---

## 3. Operational Design Notes

- **Notion 2,000-character property limit**: `toChunkedRichText` / `fromChunkedRichText` in `lib/study/repositories/mappers.ts` transparently splits long `Question Text`, `Options JSON`, `Explanation`, and JSON payloads into `<= 2,000`-character `rich_text` elements on write and concatenates them losslessly on read.
- **Ordered options & rich content**: Storing options as a JSON array in `Options JSON` preserves exact display order (`A`, `B`, `C`, `D`...) and optional per-option feedback without requiring separate child blocks per option or extra API round trips.
- **No per-keystroke Notion writes**: Writes occur only on discrete state transitions (user/exam/question upsert, review submission, or exam completion).
- **Pagination, throttling & retries**: `lib/study/notion-client.ts` enforces sequential minimum-interval throttling (`STUDY_NOTION_MIN_INTERVAL_MS=350` ≈ <3 req/s), per-request timeouts (`STUDY_NOTION_TIMEOUT_MS=15000`), exponential backoff honoring `Retry-After` on HTTP 429/5xx, and bounded cursor pagination (`STUDY_NOTION_MAX_PAGINATION_PAGES=100`).
- **Concurrency & append-only safeguards**:
  - Notion does **not** support SQL transactions or atomic compare-and-swap (CAS).
  - `ReviewEventRepository.appendIfNotExists(event)` writes immutable append-only records keyed by `eventId`, preventing duplicate logs on retried requests.
  - `FsrsCardStateRepository.save(state, { expectedRevision })` performs a read-before-write revision check and throws `ConcurrencyConflictError` if another write advanced `Revision`. Callers should reload state, recompute from `ReviewEvent` history if needed, and retry.
- **Replaceable storage**: All domain logic depends strictly on the interfaces in `lib/study/repositories/interfaces.ts`, allowing `FsrsCardStateRepository` and `ReviewEventRepository` to be migrated to a transactional SQL database (Postgres / Turso / Supabase) later without altering FSRS scheduling, grading, or UI code.
