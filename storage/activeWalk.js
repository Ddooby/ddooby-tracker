import AsyncStorage from '@react-native-async-storage/async-storage';

// 진행 중 산책 임시 저장소. '@walks_history'와 별개이며 저장/버리기 확정 시 삭제한다.
const ACTIVE_WALK_KEY = '@active_walk';

// { id: String(startedAt), startedAt: number(ms),
//   coords: [{ latitude, longitude, timestamp, accuracy }] }
//
// 한계(TRK-01 리뷰 6): 아래 queue는 JS 실행 컨텍스트(모듈 인스턴스) 안에서만 직렬화한다.
// 헤드리스 task와 화면이 서로 다른 컨텍스트면 같은 키의 읽기-수정-쓰기가 겹칠 수 있다.
// 완화책: 산책 id/startedAt 기준으로 이전 산책·중복 샘플을 버리고, 종료한 산책을 되살리지 않는다.
// 완전한 원자성(트랜잭션 저장소)은 이번 범위 밖이며 실기기에서 순서만 확인한다.
let queue = Promise.resolve();
const listeners = new Set();

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

async function readWalk() {
  const raw = await AsyncStorage.getItem(ACTIVE_WALK_KEY);
  if (!raw) return null;
  try {
    const walk = JSON.parse(raw);
    if (!walk || !Array.isArray(walk.coords)) return null;
    // id가 없는 이전 형식 기록 호환
    return walk.id ? walk : { ...walk, id: String(walk.startedAt) };
  } catch {
    return null;
  }
}

export function getActiveWalk() {
  return enqueue(readWalk);
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

// 현재 산책의 startedAt 이전 샘플과 이미 있는 timestamp(중복) 샘플은 버린다.
export function appendActiveSamples(samples) {
  return enqueue(async () => {
    const walk = await readWalk();
    if (!walk) return null; // 진행 중 산책이 없으면 늦게 온 콜백은 버린다.
    const seen = new Set(walk.coords.map((c) => c.timestamp));
    const fresh = [];
    for (const s of samples) {
      if (s.timestamp < walk.startedAt || seen.has(s.timestamp)) continue;
      seen.add(s.timestamp);
      fresh.push(s);
    }
    if (fresh.length === 0) return walk;
    const updated = { ...walk, coords: [...walk.coords, ...fresh] };
    await AsyncStorage.setItem(ACTIVE_WALK_KEY, JSON.stringify(updated));
    notify(updated);
    return updated;
  });
}

// expectedId를 주면 id가 같은 기록일 때만 지운다 (다른 산책을 잘못 지우지 않도록).
export function clearActiveWalk(expectedId) {
  return enqueue(async () => {
    if (expectedId !== undefined) {
      const walk = await readWalk();
      if (walk && walk.id !== expectedId) return;
    }
    await AsyncStorage.removeItem(ACTIVE_WALK_KEY);
  });
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
