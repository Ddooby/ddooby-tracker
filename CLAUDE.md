# Ddooby Tracker — Claude 개발팀 지침

> GPS 기반 산책 경로 기록 앱 | React Native + Expo | Android 우선
> 상태 (2026-11-11): 초기 구현 완료, Android 실기기 검증 미실시, Navigator 전환 미승인. 기능 범위와 판정 기준은 `SPEC.md`.

## 1. 프로젝트 목적

Ddooby Navigator를 개발하기 전에 GPS 기반 보행 기록의 신뢰성을 검증하는 실험 앱.
산책 경로를 GPS로 기록하고, 거리/시간을 측정하며, 이력을 저장/조회한다. 상세 범위와 수용 기준은 `SPEC.md`.
학습 목표: React Native 핵심 패턴 (GPS, 지도, 로컬 저장소, 네비게이션) 직접 구현.

## 2. 역할과 책임

- 사용자: 제품 목표·범위·단계 전환의 최종 승인.
- Claude 메인(상시 PL): 요구사항 접수, `SPEC.md`·`docs/PLAN.md`·`docs/TASKS.md` 관리, 기술 설계/작업 배분, 통합 검증, 완료 보고.
- claude-1/claude-2: 지정 파일과 기준에 따라 구현·테스트·화면 확인, 커밋과 검증 결과 보고.
- Codex: 요청 시 테스트 전략/트리아지/독립 리뷰/디자인 중 **한 요청에 한 역할**; 기본적으로 제품 코드/테스트 코드 수정 금지.
- 역할은 Orca 탭 제목(`claude-main`, `claude-1`, `claude-2`, `codex-main`, `codex-design`)으로 구분한다. 탭 ID는 PC마다 다르므로 묻거나 적지 않고 `docs/WORKFLOW.md` 7절의 명령으로 조회한다.
- 세션 포트, 실제 파일 소유권은 **현재 세션에서 확인**하고 임의로 채우지 않는다.

## 3. 문서 우선순위와 운영

1. `SPEC.md`: 무엇/왜, 기능 범위와 수용 기준. 제품 결정은 사용자.
2. `docs/PLAN.md`: 어떻게, 데이터 흐름·기술·검증 및 태스크 설계.
3. `docs/TASKS.md`: 의존 순서, 담당, 상태·완료 근거.
4. `docs/WORKFLOW.md`: worktree, 위임 요청서, 검증/리뷰 절차.
5. `AGENTS.md`: Codex 권한·산출물 기준. 관련 소스·검증·Git 규칙 변경 시 두 에이전트 지침을 동기화한다.

문서 충돌 시 **SPEC > PLAN > TASKS**. 변경되는 제품 규칙은 사용자 결정 후 SPEC → PLAN → TASKS 순으로 반영한다.

## 4. 기본 작업 흐름

1. 사용자의 요청을 Claude 메인이 요구사항/수용 기준으로 정리한다. 아직 승인되지 않은 내용은 `확인 필요`로 남긴다.
2. 실제 저장소 구조와 기존 설정/테스트 명령을 확인해 PLAN에 파일 단위 변경과 검증 방법을 정리한다.
3. 복잡한 경계 조건은 구현 전 Codex 테스트 전략, 핵심 경로 변경은 main 반영 전 Codex 독립 리뷰를 필요에 따라 요청한다.
4. claude-1·2는 서로 같은 파일을 동시에 수정하지 않고, 각 worktree의 태스크 브랜치에서 작업·테스트·커밋 뒤 메인에 보고한다.
5. 메인이 diff/요구사항/실기기 증거를 검증하고 리뷰 지적을 조치한다. 재리뷰는 최대 2회.
6. 검증된 것만 TASKS에 `[x]` 기록하고 사용자에게 변경·검증·미확인 사항 보고. 실기기 증거가 없으면 미검증으로 유지.

## 5. 기술 스택과 폴더 구조

- **Framework**: React Native + Expo (managed workflow)
- **GPS**: expo-location
- **지도**: react-native-maps
- **저장소**: @react-native-async-storage/async-storage
- **네비게이션**: @react-navigation/native + bottom-tabs

```
ddooby-tracker/
├── App.js                  # 네비게이션 루트 (Bottom Tab + Stack)
├── app.json                # Expo 설정 및 위치 권한
├── CLAUDE.md               # 이 파일 (Claude 개발팀 지침)
├── AGENTS.md               # Codex 작업 지침
├── SPEC.md                 # 무엇 / 왜, 수용 기준
├── README.md               # 현재 상태 + 실행 방법
├── docs/
│   ├── PLAN.md             # 어떻게 (구조, 설계 결정)
│   ├── TASKS.md            # 태스크 체크리스트와 완료 근거
│   └── WORKFLOW.md         # worktree, 위임 요청서, 검증/리뷰 절차
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

## 6. 구현 규칙

기존 React Native + Expo 구조를 우선한다. `hooks/useLocation.js`, `screens/HomeScreen.js`, `utils/distance.js`, `storage/walkStorage.js`와 Android 설정을 작업 전에 확인한다.

### GPS 추적
- `watchPositionAsync` 로 실시간 추적. 현행 값: `Location.Accuracy.BestForNavigation`, `timeInterval: 2000`, `distanceInterval: 5`
- 컴포넌트 언마운트·산책 종료 시 반드시 `subscription.remove()` 호출 (메모리 누수 방지)
- 위치 샘플의 타임스탬프/정확도를 보존한다 (SPEC TR-F03). 현행 코드는 `latitude`, `longitude`만 저장하며 TRK-01에서 반영한다.
- 화면 잠금 중 추적은 Android 실기기에서 검증 전까지 구현 완료로 표시하지 않는다.

### 시간
- `elapsedSeconds`는 실 시작/종료 시각에서 산출하며 UI 타이머 증가값을 진실의 원천으로 사용하지 않는다. 현행 코드는 UI 타이머 값을 `duration`으로 저장하며 TRK-02에서 교체한다.
- 이동시간과 GPS 미수집시간을 분리한다.

### 거리 계산
- **Haversine 공식** 사용 (외부 라이브러리 금지, utils/distance.js 내 직접 구현 유지)
- 좌표 배열 순회하며 누적 합산
- 이상치 필터의 임계값은 현장 샘플 확보 후 TRK-02에서 결정한다. 임의 숫자를 하드코딩하지 않는다 (SPEC 8절). 현행 코드에는 필터가 없다.

### 데이터 저장
- AsyncStorage key: `@walks_history` (고정, 변경 금지)
- 현행 저장 스키마:
  ```json
  {
    "id": "timestamp string",
    "date": "ISO8601",
    "coords": [{ "latitude": number, "longitude": number }],
    "distance": "number (미터)",
    "duration": "number (초)"
  }
  ```
- 형식 변경 시 과거 이력 읽기를 보장한다. 목표 필드는 SPEC 5절을 따른다.
- 목록은 항상 최신순 정렬 유지

### 지도
- 경로 선: `Polyline` strokeColor `#4CAF50`, strokeWidth `4`
- 출발점 마커: 파란색 핀
- 산책 중에는 `animateToRegion` 으로 현재 위치 자동 추적

## 7. 하지 말아야 할 것

- `utils/distance.js` 의 Haversine 로직을 외부 라이브러리로 교체하지 말 것
- AsyncStorage key `@walks_history` 임의 변경 금지
- `locationSubscription.remove()` 클린업 누락 금지
- 좌표 샘플에는 `latitude`, `longitude`, `timestamp`, `accuracy`만 저장한다. `altitude`, `speed` 등 불필요한 필드 포함 금지 (저장 용량 절약)

## 8. 명령과 Git

- 실행 명령은 최신 `package.json` 및 기존 README에서 **직접 확인**한다. lint, typecheck, test, build 스크립트가 없으면 임의 명령을 가정하지 않는다.
- 브랜치: `feat/<태스크ID>-<요약>`; 커밋: `[feat] <태스크ID> 설명` (수정 시 `[fix]` 등).
- main 직접 커밋 금지. 구현 탭은 독립 worktree에서 작업하고 메인 검증 후 지시에 따라 rebase/반영한다.

## 9. 검증과 보고

- 회차별 실기기 검증 결과와 코드 테스트 결과를 구분한다.
- TASKS 완료는 기대한 수용 기준과 실제 증거가 모두 일치할 때만 허용한다.
- 보고: 태스크 ID, 변경 파일·커밋, 실행 명령·결과, 현장 증거, Codex 지적·처리, 사용자 결정 필요 사항.
- 상세한 요청서와 Codex 산출물 규칙은 `docs/WORKFLOW.md`에 따른다.

## 10. 향후 개선 (지금 당장 구현 안 해도 됨)

- 저장소 교체: AsyncStorage → `expo-sqlite` (데이터 많아지면)
- 상태관리: `useState` → `Zustand`
