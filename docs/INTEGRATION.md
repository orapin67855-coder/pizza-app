# Integrating the PIZZA backend + AI into the UI

For the UI team. Nothing here has been plugged into `frontend/` yet — you choose when to adopt it.
Everything below lives in `ai/` (on-device engine, `PizzaCore`) and `backend/` (Supabase).

> Status: all exercise thresholds are **placeholders (draft)** until a physiotherapist approves them.
> The pose engine has been tried with a real camera and the real MediaPipe model for **one exercise only
> (`arm-raise`, one person, one session: 5 reps done, 5 counted)**. The other four exercises have only been
> tested with synthetic landmarks. See "Camera placement" in section 5.

## 1. Build the on-device core

```bash
cd ai && npm ci && npm run build
```

Outputs `ai/dist/pizza-core.js` (ESM) and `ai/dist/pizza-core.iife.js` (sets the global `PizzaCore`).
Copy whichever you need into your static assets (e.g. `/vendor/`).

## 2. MediaPipe assets (self-hosted, not in the repo)

- Pin **`@mediapipe/tasks-vision@0.10.14`**.
- Copy `node_modules/@mediapipe/tasks-vision/wasm/` to e.g. `/vendor/mediapipe/wasm/`.
- Download `pose_landmarker_lite.task` (official Google MediaPipe model) to e.g.
  `/vendor/mediapipe/pose_landmarker_lite.task`. Do not commit large binaries.
- The camera needs HTTPS or `localhost`. Do not load wasm/model from a CDN (privacy).

## 3. Using it from the vanilla `index.html`

```html
<script type="module">
  import * as vision from "/vendor/mediapipe/vision_bundle.mjs";
  window.__vision = vision;
</script>
<script src="/vendor/pizza-core.iife.js"></script>
<script type="module">
  const core = await PizzaCore.createPizzaCore({
    vision: window.__vision,
    assets: {
      wasmPath: "/vendor/mediapipe/wasm",
      modelPath: "/vendor/mediapipe/pose_landmarker_lite.task",
    },
  });

  const ctl = await core.pose.start(videoEl, "arm-raise", {
    onStatus: (s) => {}, // 'loading' | 'running' | 'stopped'
    onRep: (reps, target) => {},
    onCue: ({ key, text }) => speak(text), // fires only when the cue changes
    onPause: (reason) => {},
    onResume: () => {}, // person left the frame / poor tracking
    onSafetyStop: (reason) => {}, // 'carer-not-confirmed' | 'camera-stopped' | 'user-stop'
    onFrame: (r) => {}, // r.value (angle), r.quality, r.phase, r.calibrating
    onDone: (summary) => {}, // completed/stopped; already saved (summary.saved)
    onError: (e) => {},
  });

  ctl.confirmCarer(); // sit-stand and big-step do not count until a carer confirms
  ctl.requestStop(); // stop button: stops immediately
  const summary = await ctl.finished;
</script>
```

`pose.start` saves the result itself, exactly once, at the end (disable with `{ autoSave: false }`).
This also fixes the duplicate-save bug in the old `Practice.jsx` `finish()`.

ESM / React: `import { createPizzaCore } from '/vendor/pizza-core.js'` and pass
`vision` from `import * as vision from '@mediapipe/tasks-vision'`.

## 4. API

| API                                                          | Purpose                                                                                  |
| ------------------------------------------------------------ | ---------------------------------------------------------------------------------------- |
| `core.exercises.list()`                                      | Exercise list (all drafts)                                                               |
| `core.pose.start(video, exerciseId, handlers, { autoSave })` | Start an exercise, returns a controller                                                  |
| `core.sessions.save(input)` / `.list(range?)`                | Save / read history (summary numbers only; unknown fields are rejected)                  |
| `core.consent.get/set/list(purpose)`                         | PDPA consent: `sync_sessions`, `share_with_physio`, `community_clip`, `ai_summary`       |
| `core.sync.flush()`                                          | Upload summary numbers (needs a transport, a signed-in user and `sync_sessions` consent) |
| `core.data.exportAll()` / `.deleteAll()`                     | Export / erase everything (local + cloud)                                                |
| `core.storageMode`                                           | `'indexeddb'` or `'memory'` (memory = data is lost on refresh; warn the user)            |

## 5. Exercise ids and camera placement

| id                                           | Camera                                   | Carer required |
| -------------------------------------------- | ---------------------------------------- | -------------- |
| `arm-raise`, `seated-alt-arm`, `torso-twist` | Front-on, torso to hips visible          | no             |
| `sit-stand`                                  | Side-on, hip–knee–ankle visible          | **yes**        |
| `big-step`                                   | **Side-on**, shoulders to ankles visible | **yes**        |

The ids differ from `EX` in `index.html`; map them: `arm → arm-raise`, `seat → seated-alt-arm`,
`sts → sit-stand`, `trk → torso-twist`.

### Camera placement: add a framing step before the exercise starts

Every angle the engine measures needs specific body points to be clearly visible (visibility ≥ 0.5 on
each). If any needed point is out of frame or too dark, that frame is **unmeasurable**: the engine
pauses, gives the cue `person_lost` or `low_tracking`, and **counts nothing**. This is deliberate
(fail safe), but to a user it looks like "the app is broken" unless the UI guides them.

What we saw on a real camera with `arm-raise` (needs hip, shoulder and wrist on both sides):

- With the hips out of frame (typical for a laptop webcam at desk distance): every frame was
  unmeasurable, tracking stayed `poor`, and 0 reps were counted.
- Standing back so the head down to the hips were in view: the person was found on every frame,
  about 91% of frames produced an angle, and 5 reps were counted for 5 done. The other frames had no
  angle, probably while the arms were overhead and the wrists/elbows were less visible (not
  confirmed). No pause or safety stop was triggered and tracking ended `good`.

What the UI should do:

1. Show the live camera preview first, with plain wording such as: "Stand about 2 m (6 ft) from the
   camera so your head down to your hips is in view, facing the camera, in good light."
   (For `sit-stand` and `big-step`, a side view with the whole body, and a carer nearby.)
2. Do not start counting until tracking is good: use the `onQuality` handler (or `r.quality` in
   `onFrame`; values `'good' | 'fair' | 'poor'`) and enable the Start button only after a
   second or two of `'good'`.
3. During the exercise, show the cue text from `onCue` (`person_lost`: "We can't see you. Please
   step back into the camera view", `low_tracking`: "We can't see you clearly. Check the lighting
   and your position"). Do not hide them.
4. Keep the stop control always reachable.

Not yet checked on a real camera: low light, several people in the frame, tremor, and the other four
exercises (`torso-twist` also depends on MediaPipe's depth value, which is noisier).

Browser note: serve the `.mjs` files with a JavaScript MIME type. Python's `http.server` on Windows
serves `.mjs` as `text/plain`, and browsers then refuse to load the module.

## 6. Sign-in and syncing to Supabase

```js
import { createClient } from "@supabase/supabase-js";
const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
await supabase.auth.signInAnonymously(); // start without an account; link an email later via OTP

const transport = PizzaCore.createSupabaseTransport({
  functionsUrl: `${SUPABASE_URL}/functions/v1`,
  anonKey: SUPABASE_ANON_KEY,
  getAccessToken: async () =>
    (await supabase.auth.getSession()).data.session?.access_token ?? null,
});
const core = await PizzaCore.createPizzaCore({
  transport,
  vision,
  assets,
  consentTextVersion: "v1",
});

await core.consent.set("sync_sessions", true); // the user must opt in themselves
await core.sync.flush(); // summary numbers only
```

`flush()` errors: `not-signed-in`, `consent-required`, `sync-failed-<status>`.
Erasing the account (PDPA) is `core.data.deleteAll()` (local data + the `delete-me` function).

## 7. Care links and the carer / physio view

Plain Edge Function calls: `POST ${SUPABASE_URL}/functions/v1/<name>` with
`Authorization: Bearer <access_token>` and the `apikey` header.

| Who            | Call              | Body                                                                 | Result                                                                                                                                                       |
| -------------- | ----------------- | -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Patient        | `care-links`      | `{ action: 'invite', role: 'carer'\|'physio', email? }`              | `{ id, code, expiresAt }` — code like `ABCD-1234-ABCD-1234`, **shown once**, valid 7 days, single use. With `email`, only that confirmed account can accept. |
| Carer / physio | `care-links`      | `{ action: 'accept', code }`                                         | `{ linkId, memberRole }` — needs a real account (confirmed email); anonymous accounts get 403 `account_required`.                                            |
| Either side    | `care-links`      | `{ action: 'revoke', linkId }`                                       | `{ revoked: true }` — the patient can end any link or withdraw an invite; a member can leave their own link.                                                 |
| Carer / physio | `patient-summary` | `{ patientId, from?, to? }` (ISO UTC; default last 30 days, max 366) | `{ patient, range, truncated, totals, byExercise, sessions }` (camelCase, up to 500 sessions)                                                                |

- Errors: `invalid_invite` 404 · `account_required` 403 · `already_linked` 409 · `too_many_invites` 429 · `too_many_attempts` 429 (5 wrong codes in 15 minutes: that user must wait) ·
  `invalid_email` / `invalid_range` 400 · `forbidden` 403. Every refusal to read looks identical on
  purpose (no link, no consent, revoked, unknown patient), so nothing leaks.
- Reading needs an **active link and** the patient's `share_with_physio` consent (one consent covers
  both carers and physios). Withdrawing the consent or revoking the link cuts access immediately.
- List links: `GET /rest/v1/care_links?select=id,patient_id,member_id,member_role,status,invite_email,expires_at,created_at,accepted_at,revoked_at`
  (you only see links you are part of).
- "Who looked at my data": `GET /rest/v1/audit_log?select=action,actor_id,at,detail&order=id.desc`
  (read-only; patient only).
- Carers/physios have **no direct access** to the `sessions` table; `patient-summary` is the only door.
- There is no email sending yet: the patient passes the code on themselves.
- Which account counts as a verified physio (`profiles.role = 'physio'`, set by an admin) is not exposed yet.

### UI work this implies (yours, not ours)

- Patient: create/show an invite code, list links with a revoke button, show the audit log, and the
  `share_with_physio` consent toggle.
- Carer / physio: enter a code, pick a patient, show the summary.
- Wording: present these as activity numbers only. Do not call them an assessment or diagnosis.

## 8. Safety rules the UI must respect

- Video and landmarks never leave the device and are not stored.
- Fall-risk exercises do not count until `confirmCarer()` is called, and a stop control must always be reachable.
- Every exercise is a prototype until a physiotherapist approves it; do not present rep targets as prescriptions.
- Banned wording in user-facing copy: cure / heal / treat / diagnose / "detects freezing" / "prevents falls".
- The app supports activity; it is not a medical device.

## 9. Deployment note

Vercel: set **Root Directory = `frontend`** (the repository was restructured into `frontend/ backend/ ai/ docs/`).
