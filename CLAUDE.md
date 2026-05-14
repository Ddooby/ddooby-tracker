# CLAUDE.md — Ddooby-tracker

> GPS 기반 산책 경로 기록 앱 | React Native + Expo | 1인 토이 프로젝트

---

## 🎯 프로젝트 목적

산책 경로를 GPS로 기록하고, 거리/시간을 측정하며, 이력을 저장/조회하는 모바일 앱.
학습 목표: React Native 핵심 패턴 (GPS, 지도, 로컬 저장소, 네비게이션) 직접 구현.

---

## 🛠️ 기술 스택

- **Framework**: React Native + Expo (managed workflow)
- **GPS**: expo-location
- **지도**: react-native-maps
- **저장소**: @react-native-async-storage/async-storage
- **네비게이션**: @react-navigation/native + bottom-tabs

---

## 📁 폴더 구조

```
Ddooby-tracker/
├── App.js                  # 네비게이션 루트 (Bottom Tab + Stack)
├── app.json                # Expo 설정 및 위치 권한
├── CLAUDE.md               # 이 파일
├── screens/
│   ├── HomeScreen.js       # 지도 + 산책 시작/종료 메인 화면
│   ├── HistoryScreen.js    # 산책 이력 목록
│   └── DetailScreen.js     # 특정 산책 상세 경로 보기
├── hooks/
│   └── useLocation.js      # GPS 추적 커스텀 훅
├── storage/
│   └── walkStorage.js      # AsyncStorage CRUD 래퍼
└── utils/
    └── distance.js         # 거리 계산 + 포맷 유틸
```

---

## 🔑 핵심 구현 규칙

### GPS 추적
- `watchPositionAsync` 로 실시간 추적 (`timeInterval: 2000`, `distanceInterval: 5`)
- 컴포넌트 언마운트 시 반드시 `subscription.remove()` 호출 (메모리 누수 방지)
- 산책 중: `Location.Accuracy.BestForNavigation` / 대기 중: `Accuracy.Balanced`

### 거리 계산
- **Haversine 공식** 사용 (외부 라이브러리 금지, utils/distance.js 내 직접 구현 유지)
- 좌표 배열 순회하며 누적 합산
- 노이즈 필터: 2초 내 50m 초과 이동은 GPS 오류로 간주하고 무시

### 데이터 저장
- AsyncStorage key: `@walks_history` (고정, 변경 금지)
- 저장 스키마:
  ```json
  {
    "id": "timestamp string",
    "date": "ISO8601",
    "coords": [{ "latitude": number, "longitude": number }],
    "distance": "number (미터)",
    "duration": "number (초)"
  }
  ```
- 목록은 항상 최신순 정렬 유지

### 지도
- 경로 선: `Polyline` strokeColor `#4CAF50`, strokeWidth `4`
- 출발점 마커: 파란색 핀
- 산책 중에는 `animateToRegion` 으로 현재 위치 자동 추적

---

## 🚫 하지 말아야 할 것

- `utils/distance.js` 의 Haversine 로직을 외부 라이브러리로 교체하지 말 것
- AsyncStorage key `@walks_history` 임의 변경 금지
- `locationSubscription.remove()` 클린업 누락 금지
- 좌표 저장 시 `altitude`, `speed` 등 불필요한 필드 포함 금지 (저장 용량 절약)

---

## ✅ 개발 단계 체크리스트

- [ ] 프로젝트 세팅 및 패키지 설치
- [ ] app.json 위치 권한 설정 (iOS / Android)
- [ ] hooks/useLocation.js 구현
- [ ] utils/distance.js 구현
- [ ] storage/walkStorage.js 구현
- [ ] screens/HomeScreen.js 구현
- [ ] screens/HistoryScreen.js 구현
- [ ] screens/DetailScreen.js 구현
- [ ] App.js 네비게이션 연결
- [ ] UI 디자인 개선

---

## 💡 향후 개선 (지금 당장 구현 안 해도 됨)

- 백그라운드 GPS: `expo-task-manager` 연동
- 저장소 교체: AsyncStorage → `expo-sqlite` (데이터 많아지면)
- 상태관리: `useState` → `Zustand`
- 좌표 노이즈 필터링 고도화