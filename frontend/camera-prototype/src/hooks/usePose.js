import { useEffect, useRef, useState } from 'react'
import { FilesetResolver, PoseLandmarker } from '@mediapipe/tasks-vision'
// Runs on the device; video is never sent out. Put the downloaded model in public/models/ (see README)
export function usePose(videoRef, onLandmarks, active) {
  const [status, setStatus] = useState('idle'), cb = useRef(onLandmarks)
  cb.current = onLandmarks
  useEffect(() => {
    if (!active) return
    let stop = false, raf, stream, lm
    ;(async () => {
      try {
        setStatus('loading')
        const fs = await FilesetResolver.forVisionTasks('https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm')
        lm = await PoseLandmarker.createFromOptions(fs, {
          baseOptions: { modelAssetPath: '/models/pose_landmarker_lite.task' }, runningMode: 'VIDEO', numPoses: 1 })
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user' }, audio: false })
        const v = videoRef.current; v.srcObject = stream; await v.play()
        setStatus('running')
        const loop = () => {
          if (stop) return
          const res = lm.detectForVideo(v, performance.now())
          if (res.landmarks[0]) cb.current(res.landmarks[0])
          raf = requestAnimationFrame(loop)
        }
        loop()
      } catch (e) { console.error(e); setStatus('error') }
    })()
    return () => { stop = true; cancelAnimationFrame(raf); stream?.getTracks().forEach(t => t.stop()); lm?.close() }
  }, [active])
  return status
}
