# Handoff
- แอปหลัก: `index.html` (ไฟล์เดียว vanilla JS ไม่ต้อง build) ข้อมูลท่าอยู่ใน `const EX=` ดู README
- `camera-prototype/`: โปรเจกต์ React + MediaPipe รุ่นแรก (นับครั้งยกแขน) ยังไม่ได้ต่อกับแอปหลัก ต้อง `npm install` และวางโมเดล `pose_landmarker_lite.task` ที่ `camera-prototype/public/models/`
- ต้องให้นักกายภาพตรวจ: ท่า มุม ความเร็ว ข้อควรระวัง เงื่อนไขผู้ดูแล ถ้อยคำ และลิงก์ในศูนย์ความรู้
- ยังไม่ได้ทดสอบบนอุปกรณ์จริงและโปรแกรมอ่านหน้าจอ ยังไม่ได้ build/deploy camera-prototype
