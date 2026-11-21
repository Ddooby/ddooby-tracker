import { haversineDistance, calculateTotalDistance } from './distance';

// 유효 샘플 기준 (2026-11-21 사용자 승인, SPEC 8절·PLAN 3.2). 이 값은 이 파일에서만 정의한다.
export const MAX_ACCURACY_M = 20; // 보고 정확도가 이 값 이하인 샘플만 사용
export const MAX_SPEED_KMH = 25; // 직전 유효 샘플 대비 이 속도를 넘는 이동은 GPS 오류로 본다
export const SIGNAL_TIMEOUT_MS = 30000; // 시작 후 유효 샘플을 기다리는 시간(초과 시 안내)
export const CALC_VERSION = 1;

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

// 새 이력 레코드. coords는 필터 없는 원본, distance/duration은 이전 화면 호환용 별칭.
// startedAt/endedAt은 ms 숫자.
export function buildWalkRecord({ id, coords, startedAt, endedAt }) {
  const distanceMeters = calculateValidDistance(coords);
  const elapsedSeconds = calculateElapsedSeconds(startedAt, endedAt);
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
  };
}

// 화면 표시용 요약. 새 필드(calcVersion)가 있으면 사용하고, 구 기록은 distance/duration 그대로(재계산 없음).
export function getWalkSummary(walk) {
  const isNew = walk && walk.calcVersion >= 1;
  const distanceMeters = isNew ? walk.distanceMeters ?? walk.distance : walk.distance;
  const elapsedSeconds = isNew ? walk.elapsedSeconds ?? walk.duration : walk.duration;
  return { distanceMeters: distanceMeters ?? 0, elapsedSeconds: elapsedSeconds ?? 0, isNew: Boolean(isNew) };
}

// 지도에 그릴 좌표. 새 기록은 유효 샘플, 구 기록은 저장된 그대로.
export function getWalkMapCoords(walk) {
  const coords = Array.isArray(walk?.coords) ? walk.coords : [];
  return walk && walk.calcVersion >= 1 ? filterValidSamples(coords) : coords;
}
