# PIZZA – Parkinson's · In-home · Zestful · Zero-fall · Activity coach

A PWA (React + Vite) that checks physiotherapy exercises through the phone camera. Processing happens on the device; video is never sent to the cloud.

## Run locally
1. `npm install`
2. Download `pose_landmarker_lite.task` (MediaPipe Pose Landmarker) and place it in `public/models/`
3. `npm run dev`, then open it on a phone over HTTPS (the camera requires HTTPS or localhost)

## Deploy (Vercel)
`git init` → push to GitHub → import at vercel.com (Framework: Vite, build `npm run build`, output `dist`). `vercel.json` already sets the SPA rewrite.

## Done so far
5 UI pages, exercise previews + clip links, camera + rep counter (arm raise) + spoken cues, results saved on the device, carer confirmation gate before fall-risk exercises

## Next steps (in order)
1. Add measurements for sit-to-stand (knee/hip) and walking steps in `src/lib/pose.js`, and update `Practice.jsx` to choose the measurement by `move.metric`
2. Filter tremor noise (low-pass/median) before computing angles, and compare against a per-person baseline, separating ON/OFF
3. Backend (Supabase recommended): login, roles (patient/carer/physiotherapist), session results table, physiotherapist-assigned exercise sets
4. Add physiotherapist-approved tutorial clips (embedded in `Moves.jsx`) instead of YouTube search links
5. Registration page and PDPA consent, with data deletion
6. Community clips: upload, face blurring, content moderation, music copyright
7. PWA icons, service worker, testing with 3–5 physiotherapists and real patients

## Cautions
Positioned as a wellness-support tool; it makes no treatment claims (any clinical claim requires a medical-device review with the Thai FDA). The build has not been tested in this environment.
