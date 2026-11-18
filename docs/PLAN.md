# Ddooby Tracker — PLAN

> 구현 방법의 **제안 초안**. 기능·전환 판정은 `../SPEC.md`, 작업 상태는 `TASKS.md`가 기준이다.
> 2026-11-11: 현 저장소 코드/스크립트 최신 확인 필요. 실기기 검증 미실시.

## 1. 현재 기술 기반과 확인 사항

| 영역 | 기존 대화에서 확인된 기반 | 검증·대안 |
|---|---|---|
| 앱 | React Native + Expo, Android 우선 | 현재 Expo 버전·native 설정은 재확인 |
| 위치 | `expo-location` / `hooks/useLocation.js`의 `watchPositionAsync` | foreground 콜백만으로 화면 잠금 위치 추적 보장 불가; background task/권한 및 Android 제약 확인 |
| 화면 | `screens/HomeScreen.js` | 시간 계산 및 기록 시작·종료의 정확성 확인 |
| 거리 | `utils/distance.js` | 이상점 처리와 기준거리 대비 오차 검증 |
| 로컬 저장 | `storage/walkStorage.js`, 과거 대화의 `@walks_history` | 실제 키·기존 스키마 확인, 마이그레이션 또는 읽기 호환 |
| 빌드 | 이전 README: `npm install`, `npx expo run:android` | 프로젝트 스크립트·실기기 연결 재확인 |

**현재 코드 상태는 과거 대화의 스냅샷 정보이며 최신 `main` 재확인 전에는 확정하지 않는다.**

## 2. 책임·의존 방향

```text
screens/HomeScreen.js (UI, 이벤트)
  → hooks/useLocation.js (위치 수집/구독 생명주기)
  → utils/ (순수 시간·거리·이동 판정 계산)
  → storage/walkStorage.js (버전 포함 기록 저장·조회)
```

- UI는 GPS 품질·거리 계산 상세를 직접 구현하지 않는다.
- 위치 수집은 시작/일시중단/종료와 권한 상태를 명시적으로 관리한다.
- 데이터 스키마 변경 시 기존 이력 읽기 호환 및 제외/결측 정책을 검증한다.

## 3. 구현 순서 및 태스크별 설계

### 3.1 TRK-01 — 잠금 상태 위치 기록

- 대상: `package.json`(`expo-task-manager`), `app.json`(expo-location 플러그인·앱 이름), `tasks/locationTask.js`(신규), `index.js`, `hooks/useLocation.js`, `screens/HomeScreen.js`.
- **결정 (2026-11-18, 사용자 승인)**: Android 포그라운드 서비스 방식. `startLocationUpdatesAsync(task, { foregroundService })`는 알림이 있는 사용자 시작 서비스이면 `ACCESS_BACKGROUND_LOCATION` 없이 동작한다 (근거: `node_modules/expo-location/android/.../LocationModule.kt:252-255`, expo-location 19.0.8). 플러그인 `isAndroidForegroundServiceEnabled: true`, `isAndroidBackgroundLocationEnabled: false`.
- 데이터 흐름: task 콜백 → 샘플 `{latitude, longitude, timestamp, accuracy}`를 `@active_walk`에 추가 저장 + 앱이 떠 있으면 화면에 전달 → 종료 시 `stopLocationUpdatesAsync` 후 기존 `saveWalk`로 `@walks_history` 저장, `@active_walk` 삭제.
- 앱 재실행 시 `hasStartedLocationUpdatesAsync`와 `@active_walk`로 진행 중 산책을 복원한다. 중복 시작을 막는다.
- 권한 거부: 다시 요청 가능하면 재요청, `canAskAgain === false`면 설정 열기(`Linking.openSettings`)를 안내한다.
- 알림 문구: 제목 "산책 기록 중", 내용 "화면이 꺼져도 경로를 기록합니다".
- 범위 밖(TRK-02): 시작·종료 시각 기반 시간, 정지 판정, 거리 이상치, 저장 스키마 버전. `utils/distance.js` 변경 없음.
- 검증: 자동 테스트 스크립트 없음(미구축). 실기기 시나리오 — 잠금 3~5분 보행, 앱 전환 후 복귀, 권한 거부→재시도/설정, 종료 후 알림·`dumpsys location` 요청 해제, 저장 좌표 `timestamp`/`accuracy`, 프로세스 강제 종료 후 복원.
- 좌표마다 측정 시각·정확도 포함. 수집 간격/거리 조건은 성능과 배터리 소비를 실측해 조정한다.
- 부작용: 배터리·권한 UX·스토어 정책. 상용 서비스의 상시 추적 기능으로 확대하지 않는다.

### 3.2 TRK-02 — 측정과 저장

- 대상 후보: `screens/HomeScreen.js`, `utils/distance.js`, `storage/walkStorage.js` 및 필요할 경우 별도 순수 계산 모듈.
- `elapsedSeconds = endedAt - startedAt`(사용자 시작/종료를 기준으로 계산). UI 타이머는 표현만 맡는다.
- GPS 기록은 원본을 보존하면서 유효 샘플을 필터링해 거리를 계산한다.
- 정지/이동 판정은 `accuracy`, 샘플 간 거리·시간, 위치 공백을 함께 고려한다. 임계값은 현장 데이터 확인 뒤 명문화한다.
- 속도는 `유효 이동거리 / 유효 이동시간`; 정지시간과 위치 미수집시간을 같은 개념으로 취급하지 않는다.
- 저장 스키마 버전 또는 호환 로더를 도입해 과거 이력이 열리는지 확인한다. 누락 필드는 '미측정'으로 처리하고 속도 학습에서 제외할 수 있게 한다.

### 3.3 TRK-03 — Android 현장 테스트

- 두 날짜 이상, 15분/30분 각 3회. 매 회차 트인 길/빌딩 사이/잠금 구간, 가능하면 의도적 1분 정지 포함.
- 표: 일시, 기기·OS·빌드 커밋, 코스 ID, 스톱워치 초, 앱 총시간 초, 독립 기준거리 m, 앱 거리 m, 잠금 중 기록, 정지 제외 결과, 공백·권한 이슈, 판정.
- **정밀 GPS 경로는 공개 문서에 기재하지 않는다**. 근거 로그는 비공개 로컬로 관리한다.
- 평균 수치 하나로 합격 처리하지 말고 SPEC의 회차별 조건을 적용한다.

### 3.4 TRK-04 — 독립 리뷰·인계

- Claude 메인이 구현/현장 증거를 확인한 후 Codex 독립 리뷰를 요청한다.
- Reviewer는 잠금 수집, 시간 원천, 거리 이상치, 이전 이력, 개인정보, 실기기 증거와 소스의 차이를 검토한다.
- 리뷰 지적 처리·재검증 후 **사용자가 전환 승인**하면 Navigator에서 활용할 검증 커밋과 인터페이스를 고정한다.

## 4. 검증 전략

| 수준 | 대상 | 통과 확인 |
|---|---|---|
| 단위 | 거리, 시간차, 정지/공백, 결측, 이상 좌표 | 정상·경계·역전된 시각·0초·정확도 낮음 케이스 |
| 통합 | 위치 수집→종료→저장→재조회 | 앱 재시작 후 기록 일관성 및 이전 데이터 호환 |
| 실기기 | 화면 잠금, 권한, 수집 중단, 6회 기록 | `SPEC.md` 6절 기준을 직접 증명 |
| 독립 리뷰 | GPS·시간·저장 핵심 경로 | 수정 diff 및 증거 중심의 읽기 전용 검토 |

**명령 확인 필요**: `package.json`의 `lint`, `test`, `typecheck`, `build` 스크립트는 최신 저장소에서 확인해야 한다. 없는 명령은 실행한 것으로 기록하지 않는다. Android 실기기 실행 후보: `npm install`, `npx expo run:android` (이전 README 기준).

## 5. 배포·운영

- 개발 실기기 빌드 중심. 스토어 배포는 전환 게이트 범위 밖.
- 위치 권한과 백그라운드 고지, GPS 배터리 비용, 위치 로그 노출 위험을 관리한다.
- `.env`/비밀 키를 커밋하지 않는다. 화면 캡처/테스트 기록에는 개인 동선을 제거한다.

## 6. 미확정 설계 항목

- ~~Android 잠금 중 기록 방식~~ → 3.1에서 포그라운드 서비스로 결정 (2026-11-18). 남은 확인: Samsung 배터리 최적화가 서비스를 종료하는지 실기기 확인.
- 이동/정지/수집 공백/정확도 필터의 수치 기준과 표시 UX.
- 과거 기록 스키마 및 저장 키 확인 후 마이그레이션 방식.
