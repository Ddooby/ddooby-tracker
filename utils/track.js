import { haversineDistance, calculateTotalDistance } from './distance';

// 유효 샘플 기준 (2026-11-21 사용자 승인, SPEC 8절·PLAN 3.2). 이 값은 이 파일에서만 정의한다.
export const MAX_ACCURACY_M = 20; // 보고 정확도가 이 값 이하인 샘플만 사용
export const MAX_SPEED_KMH = 25; // 직전 유효 샘플 대비 이 속도를 넘는 이동은 GPS 오류로 본다
export const SIGNAL_TIMEOUT_MS = 30000; // 시작 후 유효 샘플을 기다리는 시간(초과 시 안내)
export const CALC_VERSION = 2; // 2: 일시정지(pauses)·movingSeconds 도입 (1 이하 기록은 그대로 읽는다)
// 진행 방향(bearing)을 그릴 최소 이동 거리. 이보다 적게 움직였으면 방향을 생략한다(GPS 흔들림으로 화살표가 도는 것 방지).
export const MIN_HEADING_DISTANCE_M = 4;
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

// 일시정지 구간 목록을 닫힌 [{start,end}]로 정리한다(순수 함수).
// - pauses: 저장된 완료 구간, pausedAt: 아직 안 끝난 일시정지 시작 시각(있으면 endedAt, 없으면 무한대까지)
// - 숫자가 아니거나 end<=start인 구간은 버리고, 시작 시각 순으로 정렬해 겹치는 구간은 합친다.
export function normalizePauses(pauses, pausedAt, endedAt) {
  const list = [];
  for (const p of Array.isArray(pauses) ? pauses : []) {
    if (p && typeof p.start === 'number' && typeof p.end === 'number' && p.end > p.start) {
      list.push({ start: p.start, end: p.end });
    }
  }
  if (typeof pausedAt === 'number') {
    const end = typeof endedAt === 'number' ? endedAt : Infinity;
    if (end > pausedAt) list.push({ start: pausedAt, end });
  }
  list.sort((a, b) => a.start - b.start);
  const merged = [];
  for (const p of list) {
    const last = merged[merged.length - 1];
    if (last && p.start <= last.end) last.end = Math.max(last.end, p.end);
    else merged.push({ ...p });
  }
  return merged;
}

// 원본 샘플을 일시정지 경계로 구간(segment)으로 나눈다. 일시정지 구간 안의 샘플(늦게 도착한 배치 포함)은 버리고,
// 경계를 넘어 이어 붙이지 않는다. timestamp 없는 구 샘플은 첫 구간에 둔다. 원본 배열은 수정하지 않는다.
export function splitSegments(samples, pauses = []) {
  if (!Array.isArray(samples)) return [];
  const closed = Array.isArray(pauses) ? pauses : [];
  const segments = Array.from({ length: closed.length + 1 }, () => []);
  for (const s of samples) {
    if (!s) continue;
    if (typeof s.timestamp !== 'number') {
      segments[0].push(s);
      continue;
    }
    let index = 0;
    let inside = false;
    for (const p of closed) {
      if (s.timestamp >= p.end) index += 1;
      else {
        inside = s.timestamp >= p.start;
        break;
      }
    }
    if (!inside) segments[index].push(s);
  }
  return segments.filter((seg) => seg.length > 0);
}

// 구간별 유효 샘플(구간마다 "직전 유효 샘플"을 새로 시작: 경계 넘어 속도·거리를 비교하지 않는다).
export function filterValidSegments(samples, pauses = []) {
  return splitSegments(samples, pauses)
    .map((seg) => filterValidSamples(seg))
    .filter((seg) => seg.length > 0);
}

// 구간들의 거리 합(m). 구간 사이는 잇지 않는다.
export function sumSegmentsDistance(segments) {
  return segments.reduce((sum, seg) => sum + calculateTotalDistance(seg), 0);
}

// 경로로 쓸 수 있는 구간(유효 샘플 2개 이상)이 하나라도 있는가.
export function hasValidPath(samples, pauses = []) {
  return filterValidSegments(samples, pauses).some((seg) => seg.length >= 2);
}

// 유효 샘플만으로 계산한 거리(m). Haversine은 utils/distance.js를 그대로 쓴다.
// pauses(닫힌 구간)가 있으면 구간별로 나눠 합한다. 없으면 기존과 같다.
export function calculateValidDistance(samples, pauses = []) {
  return sumSegmentsDistance(filterValidSegments(samples, pauses));
}

// 두 지점 사이 방위각(도, 0=북, 시계 방향 0~360).
export function calculateBearing(lat1, lon1, lat2, lon2) {
  const rad = (d) => (d * Math.PI) / 180;
  const dLon = rad(lon2 - lon1);
  const y = Math.sin(dLon) * Math.cos(rad(lat2));
  const x =
    Math.cos(rad(lat1)) * Math.sin(rad(lat2)) - Math.sin(rad(lat1)) * Math.cos(rad(lat2)) * Math.cos(dLon);
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}

// 마지막 구간의 마지막 유효 샘플 기준 진행 방향(도). 같은 구간 안에서 직전 최대 5개 유효 샘플 중
// MIN_HEADING_DISTANCE_M 이상 떨어진 가장 가까운 샘플과 비교하고, 없으면 null(방향 생략).
export function calculateHeading(validSegments) {
  const seg = validSegments[validSegments.length - 1];
  if (!seg || seg.length < 2) return null;
  const last = seg[seg.length - 1];
  for (let i = seg.length - 2; i >= 0 && i >= seg.length - 6; i -= 1) {
    const meters = haversineDistance(seg[i].latitude, seg[i].longitude, last.latitude, last.longitude);
    if (meters >= MIN_HEADING_DISTANCE_M) {
      return calculateBearing(seg[i].latitude, seg[i].longitude, last.latitude, last.longitude);
    }
  }
  return null;
}

// 시작/종료 시각(ms)에서 산출한 경과 시간(초). 역전된 시각은 0.
export function calculateElapsedSeconds(startedAt, endedAt) {
  if (typeof startedAt !== 'number' || typeof endedAt !== 'number') return 0;
  return Math.max(0, Math.round((endedAt - startedAt) / 1000));
}

// 이동시간(초) = 총시간 − 일시정지 합. 진행 중인 일시정지(pausedAt)는 endedAt(없으면 지금)까지로 본다.
// 일시정지 구간은 [startedAt, endedAt]로 잘라 계산한다. 시각이 숫자가 아니면 0.
export function calculateMovingSeconds(startedAt, endedAt, pauses = [], pausedAt) {
  if (typeof startedAt !== 'number' || typeof endedAt !== 'number') return 0;
  const total = Math.max(0, endedAt - startedAt);
  let paused = 0;
  for (const p of normalizePauses(pauses, pausedAt, endedAt)) {
    const start = Math.max(p.start, startedAt);
    const end = Math.min(p.end, endedAt);
    if (end > start) paused += end - start;
  }
  return Math.max(0, Math.round((total - paused) / 1000));
}

// 평균 속도(km/h) = 거리 / 경과 시간(일시정지가 있으면 이동시간). 시간이 0이면 0.
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
  // 일시정지 중이던 산책이면 일시정지 시작 시각도 하한에 포함한다(그 뒤는 일시정지 시간으로 본다).
  const pausedAt = typeof walk.pausedAt === 'number' ? walk.pausedAt : walk.startedAt;
  return { endedAt: Math.max(walk.startedAt, lastTs, alive, pausedAt), estimated: true };
}

// 새 이력 레코드. coords는 필터 없는 원본, distance/duration은 이전 화면 호환용 별칭.
// startedAt/endedAt은 ms 숫자.
// endedAtEstimated=true: 종료 시각을 알 수 없어 마지막 샘플 시각으로 추정한 경우(하한).
// pauses/pausedAt: 일시정지 구간(완료)과 종료 시점에 진행 중이던 일시정지 시작 시각. 진행 중이던 일시정지는
// 종료 시각에서 닫아 pauses에 넣는다. 일시정지 구간 안의 샘플은 거리·경로에서 제외하고 구간 사이는 잇지 않는다.
// movingSeconds = elapsedSeconds − 일시정지 합. pauses 필드는 일시정지가 있을 때만 저장한다.
// 유효 경로 구간(유효 샘플 2개 이상)이 없으면 quality='no-valid-path'(거리 0), 원본 샘플이 0개면 'no-location'으로
// 표시하고 원본·시간은 그대로 저장한다.
export function buildWalkRecord({
  id,
  coords,
  startedAt,
  endedAt,
  endedAtEstimated = false,
  pauses = [],
  pausedAt,
}) {
  const closedPauses = normalizePauses(pauses, pausedAt, endedAt);
  const distanceMeters = calculateValidDistance(coords, closedPauses);
  const elapsedSeconds = calculateElapsedSeconds(startedAt, endedAt);
  const movingSeconds = calculateMovingSeconds(startedAt, endedAt, closedPauses);
  const quality =
    coords.length === 0
      ? QUALITY_NO_LOCATION
      : !hasValidPath(coords, closedPauses)
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
    movingSeconds,
    distanceMeters,
    calcVersion: CALC_VERSION,
    ...(closedPauses.length > 0 ? { pauses: closedPauses } : {}),
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
      // calcVersion 2부터 저장되는 이동시간. 없으면(이전 기록) 총시간과 같다(일시정지 개념 없음).
      movingSeconds:
        typeof walk.movingSeconds === 'number'
          ? walk.movingSeconds
          : (walk.elapsedSeconds ?? walk.duration ?? 0),
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
      movingSeconds: spanSeconds ?? walk?.duration ?? 0,
      isNew: false,
      recalculated: true,
    };
  }
  return {
    distanceMeters: walk?.distance ?? 0,
    elapsedSeconds: walk?.duration ?? 0,
    movingSeconds: walk?.duration ?? 0,
    isNew: false,
    recalculated: false,
  };
}

// 지도에 그릴 구간별 좌표(Polyline마다 한 구간). 새 기록과 timestamp·accuracy 있는 구 기록은 구간별 유효 샘플
// (일시정지 경계에서 나눔), 그 외는 저장된 좌표 한 구간 그대로.
export function getWalkMapSegments(walk) {
  const coords = Array.isArray(walk?.coords) ? walk.coords : [];
  if ((walk && walk.calcVersion >= 1) || hasMeasuredSamples(coords)) {
    return filterValidSegments(coords, normalizePauses(walk?.pauses));
  }
  return coords.length > 0 ? [coords] : [];
}

// 지도에 그릴 좌표를 이어 붙인 목록(출발·도착 마커용).
export function getWalkMapCoords(walk) {
  return getWalkMapSegments(walk).flat();
}
