import { haversineDistance, calculateTotalDistance } from './distance';

// 유효 샘플 기준 (2026-11-21 사용자 승인, SPEC 8절·PLAN 3.2). 이 값은 이 파일에서만 정의한다.
export const MAX_ACCURACY_M = 20; // 보고 정확도가 이 값 이하인 샘플만 사용
export const MAX_SPEED_KMH = 25; // 직전 유효 샘플 대비 이 속도를 넘는 이동은 GPS 오류로 본다
export const SIGNAL_TIMEOUT_MS = 30000; // 시작 후 유효 샘플을 기다리는 시간(초과 시 안내)
export const CALC_VERSION = 1;
// 앱이 화면에 있고 서비스·권한이 확인된 산책 중에 lastAliveAt을 기록하는 간격. 추정 종료 시각 오차의 "목표"는 5초이며
// 보장값이 아니다(앱이 백그라운드·기록 지연이면 더 커질 수 있고, 그 경우에도 endedAtEstimated로 표시된다).
// 목표를 맞추려고 간격은 3초로 둔다.
export const ALIVE_HEARTBEAT_MS = 3000;
export const QUALITY_NO_VALID_PATH = 'no-valid-path'; // 유효 샘플이 2개 미만이라 경로를 측정하지 못한 기록
export const QUALITY_NO_LOCATION = 'no-location'; // 위치 샘플이 하나도 없는 기록(시간만 저장)

// 원본 샘플 배열 → 유효 샘플 배열(원본은 수정하지 않는다).
// - timestamp 없는 샘플(구 스키마)은 accuracy·속도 판정 없이 그대로 통과한다.
// - accuracy가 숫자가 아니거나 MAX_ACCURACY_M 초과면 제외한다.
// - 속도는 "직전 유효 샘플" 기준으로 판정한다(튄 점 다음 점이 튄 점과 비교돼 버려지지 않게).
//   시간 차가 0 이하(중복·역순)면 속도를 알 수 없으므로 제외한다.
export function filterValidSamples(samples) {
  if (!Array.isArray(samples)) return [];
  const valid = [];
  let prev = null;
  for (const s of samples) {
    if (!s) continue;
    if (typeof s.timestamp !== 'number') {
      valid.push(s);
      continue;
    }
    if (typeof s.accuracy !== 'number' || !(s.accuracy <= MAX_ACCURACY_M)) continue;
    if (prev) {
      const seconds = (s.timestamp - prev.timestamp) / 1000;
      if (seconds <= 0) continue;
      const meters = haversineDistance(prev.latitude, prev.longitude, s.latitude, s.longitude);
      if ((meters * 3.6) / seconds > MAX_SPEED_KMH) continue;
    }
    valid.push(s);
    prev = s;
  }
  return valid;
}

// 유효 샘플만으로 계산한 거리(m). Haversine은 utils/distance.js를 그대로 쓴다.
export function calculateValidDistance(samples) {
  return calculateTotalDistance(filterValidSamples(samples));
}

// 시작/종료 시각(ms)에서 산출한 경과 시간(초). 역전된 시각은 0.
export function calculateElapsedSeconds(startedAt, endedAt) {
  if (typeof startedAt !== 'number' || typeof endedAt !== 'number') return 0;
  return Math.max(0, Math.round((endedAt - startedAt) / 1000));
}

// 평균 속도(km/h) = 거리 / 경과 시간. 경과 0이면 0.
export function calculateSpeedKmh(distanceMeters, elapsedSeconds) {
  if (!(elapsedSeconds > 0)) return 0;
  return distanceMeters / 1000 / (elapsedSeconds / 3600);
}

// 저장되지 않은 산책의 종료 시각. 영속화된 endedAt(사용자 종료 요청)이 있으면 그 값을, 없으면(OS가 수집을
// 중단한 경우) max(마지막 샘플 시각, lastAliveAt, 시작 시각)을 하한 추정값으로 쓴다(estimated=true).
// lastAliveAt은 앱이 화면에 있는 동안 ALIVE_HEARTBEAT_MS마다 메타에 기록한 시각이라 샘플이 드문(정지·실내)
// 산책에서도 추정 오차를 줄인다.
export function resolveEndedAt(walk) {
  if (typeof walk.endedAt === 'number') {
    return { endedAt: Math.max(walk.startedAt, walk.endedAt), estimated: false };
  }
  const last = Array.isArray(walk.coords) ? walk.coords[walk.coords.length - 1] : null;
  const lastTs = last && typeof last.timestamp === 'number' ? last.timestamp : walk.startedAt;
  const alive = typeof walk.lastAliveAt === 'number' ? walk.lastAliveAt : walk.startedAt;
  return { endedAt: Math.max(walk.startedAt, lastTs, alive), estimated: true };
}

// 새 이력 레코드. coords는 필터 없는 원본, distance/duration은 이전 화면 호환용 별칭.
// startedAt/endedAt은 ms 숫자.
// endedAtEstimated=true: 종료 시각을 알 수 없어 마지막 샘플 시각으로 추정한 경우(하한).
// 유효 샘플이 2개 미만이면 quality='no-valid-path'(거리 0), 원본 샘플이 0개면 'no-location'으로 표시하고
// 원본·시간은 그대로 저장한다.
export function buildWalkRecord({ id, coords, startedAt, endedAt, endedAtEstimated = false }) {
  const distanceMeters = calculateValidDistance(coords);
  const elapsedSeconds = calculateElapsedSeconds(startedAt, endedAt);
  const quality =
    coords.length === 0
      ? QUALITY_NO_LOCATION
      : filterValidSamples(coords).length < 2
        ? QUALITY_NO_VALID_PATH
        : null;
  return {
    id,
    date: new Date(endedAt).toISOString(),
    coords,
    distance: distanceMeters,
    duration: elapsedSeconds,
    startedAt,
    endedAt,
    elapsedSeconds,
    distanceMeters,
    calcVersion: CALC_VERSION,
    ...(endedAtEstimated ? { endedAtEstimated: true } : {}),
    ...(quality ? { quality } : {}),
  };
}

// calcVersion이 없는 구 기록이라도 모든 샘플에 timestamp·accuracy가 있으면 표시할 때만 다시 계산한다
// (저장소 원본은 바꾸지 않는다). timestamp/accuracy가 없는 아주 예전 기록은 저장값 그대로 둔다.
function hasMeasuredSamples(coords) {
  return (
    coords.length > 0 &&
    coords.every((s) => s && typeof s.timestamp === 'number' && typeof s.accuracy === 'number')
  );
}

// 화면 표시용 요약(목록·상세 공용). 계산을 화면마다 두지 않고 여기 한 곳에서 한다.
// - 새 기록(calcVersion ≥ 1): 저장된 distanceMeters/elapsedSeconds
// - 구 기록 + timestamp·accuracy 있음: 유효 샘플 거리, 시간은 첫~마지막 샘플 timestamp 차(샘플 2개 미만이면 저장값)
// - 그 외(아주 예전 기록): 저장된 distance/duration
// recalculated=true면 저장값이 아닌 표시용 재계산 값이다.
export function getWalkSummary(walk) {
  const coords = Array.isArray(walk?.coords) ? walk.coords : [];
  if (walk && walk.calcVersion >= 1) {
    return {
      distanceMeters: walk.distanceMeters ?? walk.distance ?? 0,
      elapsedSeconds: walk.elapsedSeconds ?? walk.duration ?? 0,
      isNew: true,
      recalculated: false,
    };
  }
  if (hasMeasuredSamples(coords)) {
    const stamps = coords.map((s) => s.timestamp);
    const spanSeconds =
      coords.length >= 2 ? Math.round((Math.max(...stamps) - Math.min(...stamps)) / 1000) : null;
    return {
      distanceMeters: calculateValidDistance(coords),
      elapsedSeconds: spanSeconds ?? walk?.duration ?? 0,
      isNew: false,
      recalculated: true,
    };
  }
  return {
    distanceMeters: walk?.distance ?? 0,
    elapsedSeconds: walk?.duration ?? 0,
    isNew: false,
    recalculated: false,
  };
}

// 지도에 그릴 좌표. 새 기록과 timestamp·accuracy 있는 구 기록은 유효 샘플, 그 외는 저장된 그대로.
export function getWalkMapCoords(walk) {
  const coords = Array.isArray(walk?.coords) ? walk.coords : [];
  return (walk && walk.calcVersion >= 1) || hasMeasuredSamples(coords)
    ? filterValidSamples(coords)
    : coords;
}
