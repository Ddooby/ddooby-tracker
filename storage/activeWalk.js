import AsyncStorage from '@react-native-async-storage/async-storage';

// 진행 중 산책 임시 저장소. '@walks_history'와 별개이며 저장/버리기 확정 시 삭제한다.
const ACTIVE_WALK_KEY = '@active_walk';

// { startedAt: number(ms), coords: [{ latitude, longitude, timestamp, accuracy }] }
let queue = Promise.resolve();
const listeners = new Set();

// 읽기-수정-쓰기를 한 줄로 세워 동시 task 콜백이 서로 덮어쓰지 않게 한다.
function enqueue(job) {
  const run = queue.then(job, job);
  queue = run.catch(() => {});
  return run;
}

export function toSample(location) {
  return {
    latitude: location.coords.latitude,
    longitude: location.coords.longitude,
    timestamp: location.timestamp,
    accuracy: location.coords.accuracy,
  };
}

export async function getActiveWalk() {
  const raw = await AsyncStorage.getItem(ACTIVE_WALK_KEY);
  if (!raw) return null;
  try {
    const walk = JSON.parse(raw);
    return walk && Array.isArray(walk.coords) ? walk : null;
  } catch {
    return null;
  }
}

function notify(walk) {
  listeners.forEach((listener) => {
    try {
      listener(walk);
    } catch (e) {
      console.warn('[activeWalk] listener error', e);
    }
  });
}

export function startActiveWalk(walk) {
  return enqueue(async () => {
    await AsyncStorage.setItem(ACTIVE_WALK_KEY, JSON.stringify(walk));
    notify(walk);
  });
}

export function appendActiveSamples(samples) {
  return enqueue(async () => {
    const walk = await getActiveWalk();
    if (!walk) return null; // 진행 중 산책이 없으면 늦게 온 콜백은 버린다.
    const updated = { ...walk, coords: [...walk.coords, ...samples] };
    await AsyncStorage.setItem(ACTIVE_WALK_KEY, JSON.stringify(updated));
    notify(updated);
    return updated;
  });
}

export function clearActiveWalk() {
  return enqueue(() => AsyncStorage.removeItem(ACTIVE_WALK_KEY));
}

// 대기 중인 저장 작업이 모두 끝난 뒤 resolve (종료 직후 마지막 샘플 반영용)
export function whenActiveWalkIdle() {
  return enqueue(async () => {});
}

// 앱이 떠 있을 때 화면이 최신 산책 데이터를 받는 구독. 반환값은 해제 함수.
export function subscribeActiveWalk(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
