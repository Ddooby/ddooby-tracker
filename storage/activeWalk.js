import AsyncStorage from '@react-native-async-storage/async-storage';

// 진행 중 산책 임시 저장소. '@walks_history'와 별개이며 저장/버리기 확정 시 삭제한다.
//
// 구조 (헤드리스 task와 UI가 같은 키를 읽고-수정-쓰지 않도록 분리)
//   '@active_walk'                                   메타만: { id, startedAt }
//   '@active_walk_samples:<id>:<첫 ts>:<배치 id>'    task 콜백 한 배치의 샘플 배열 (쓰기 전용)
//   '@active_walk_samples:<id>:<첫 ts>:init'         시작 시 첫 샘플 (별도 키, startedAt 필터 제외)
// 산책 id는 위치 timestamp와 무관한 고유값(newWalkId), 배치 id는 TaskManager eventId(없으면 무작위)라서
// 같은 첫 timestamp의 배치끼리도 키가 겹치지 않는다.
// 이전 빌드는 '@active_walk'에 coords(또는 samples) 배열을 함께 저장했다. 읽을 때 필터 없이 병합한다.
//
// 한계: 컨텍스트 간 원자성은 없다. 종료(메타 삭제) 직후 헤드리스 콜백이 키를 쓰면 쓰기 후 재확인으로
// 지우지만 그 사이 틈은 남을 수 있고, 남은 고아 키는 앱 시작 복원·새 산책 시작 때 지운다.
const META_KEY = '@active_walk';
const SAMPLES_PREFIX = '@active_walk_samples:';

let queue = Promise.resolve();
const listeners = new Set();

function enqueue(job) {
  const run = queue.then(job, job);
  queue = run.catch(() => {});
  return run;
}

const samplePrefixFor = (id) => `${SAMPLES_PREFIX}${id}:`;
const randomPart = () => Math.random().toString(36).slice(2, 8);
const INIT_BATCH = 'init';

// 위치 timestamp와 분리된 고유 산책 id (':' 없음)
export function newWalkId() {
  return `${Date.now()}-${randomPart()}`;
}

export function toSample(location) {
  return {
    latitude: location.coords.latitude,
    longitude: location.coords.longitude,
    timestamp: location.timestamp,
    accuracy: location.coords.accuracy,
  };
}

// 샘플 목록들을 합쳐 timestamp 기준 중복 제거 + 오름차순 정렬. 4개 필드만 남긴다.
export function mergeSamples(...lists) {
  const byTimestamp = new Map();
  for (const list of lists) {
    for (const s of list ?? []) {
      if (!s || typeof s.timestamp !== 'number' || byTimestamp.has(s.timestamp)) continue;
      byTimestamp.set(s.timestamp, {
        latitude: s.latitude,
        longitude: s.longitude,
        timestamp: s.timestamp,
        accuracy: s.accuracy,
      });
    }
  }
  return [...byTimestamp.values()].sort((a, b) => a.timestamp - b.timestamp);
}

async function readMeta() {
  const raw = await AsyncStorage.getItem(META_KEY);
  if (!raw) return null;
  let meta;
  try {
    meta = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!meta || typeof meta.startedAt !== 'number') return null;
  return { ...meta, id: meta.id ?? String(meta.startedAt) };
}

async function keysWithPrefix(prefix) {
  const keys = await AsyncStorage.getAllKeys();
  return keys.filter((k) => k.startsWith(prefix));
}

function notify(payload) {
  listeners.forEach((listener) => {
    try {
      listener(payload);
    } catch (e) {
      console.warn('[activeWalk] listener error', e);
    }
  });
}

// 진행 중 산책 조회: 메타 + 해당 id의 모든 샘플 키를 병합. 읽기 오류는 호출자에게 전달한다.
export function getActiveWalk() {
  return enqueue(async () => {
    const meta = await readMeta();
    if (!meta) return null;
    const keys = await keysWithPrefix(samplePrefixFor(meta.id));
    const pairs = keys.length ? await AsyncStorage.multiGet(keys) : [];
    const batches = [];
    for (const [key, value] of pairs) {
      if (!value) continue;
      try {
        const batch = JSON.parse(value);
        if (!Array.isArray(batch)) continue;
        // startedAt 이전 샘플은 task 배치에서만 버린다 (시작 시 첫 샘플은 유지)
        batches.push(key.endsWith(`:${INIT_BATCH}`) ? batch : batch.filter((s) => s.timestamp >= meta.startedAt));
      } catch {
        // 깨진 배치는 건너뛴다
      }
    }
    // 이전 형식 배열(coords/samples)은 필터 없이 그대로 병합한다.
    const coords = mergeSamples(meta.coords, meta.samples, ...batches);
    return { id: meta.id, startedAt: meta.startedAt, coords };
  });
}

// 새 산책 시작: 다른 id의 고아 샘플 키를 지우고 메타 + 첫 샘플 배치를 쓴다.
export function startActiveWalk({ id, startedAt }, initialSamples = []) {
  return enqueue(async () => {
    const orphans = (await keysWithPrefix(SAMPLES_PREFIX)).filter(
      (k) => !k.startsWith(samplePrefixFor(id))
    );
    if (orphans.length) await AsyncStorage.multiRemove(orphans);
    const pairs = [[META_KEY, JSON.stringify({ id, startedAt })]];
    if (initialSamples.length) {
      pairs.push([
        `${samplePrefixFor(id)}${initialSamples[0].timestamp}:${INIT_BATCH}`,
        JSON.stringify(initialSamples),
      ]);
    }
    await AsyncStorage.multiSet(pairs);
  });
}

// task 콜백용: 메타만 읽고 배치 키에 쓰기만 한다 (공유 키 읽기-수정-쓰기 없음).
// 쓴 뒤 메타를 다시 읽어 산책이 끝났거나 id가 달라졌으면 방금 쓴 키를 지운다 (늦은 쓰기 완화).
export function appendActiveSamples(samples, batchId) {
  return enqueue(async () => {
    const meta = await readMeta();
    if (!meta) return null; // 진행 중 산책이 없으면 늦게 온 콜백은 버린다.
    const fresh = samples.filter((s) => s.timestamp >= meta.startedAt);
    if (fresh.length === 0) return meta;
    const key = `${samplePrefixFor(meta.id)}${fresh[0].timestamp}:${batchId ?? randomPart()}`;
    await AsyncStorage.setItem(key, JSON.stringify(fresh));
    const after = await readMeta();
    if (!after || after.id !== meta.id) {
      await AsyncStorage.removeItem(key);
      return null;
    }
    notify({ id: meta.id, samples: fresh });
    return meta;
  });
}

// 메타가 없거나 id가 다른 샘플 키(고아)를 지운다. 앱 시작 복원 때 호출한다.
export function cleanupOrphanSamples() {
  return enqueue(async () => {
    const meta = await readMeta();
    const keys = await keysWithPrefix(SAMPLES_PREFIX);
    const orphans = meta ? keys.filter((k) => !k.startsWith(samplePrefixFor(meta.id))) : keys;
    if (orphans.length) await AsyncStorage.multiRemove(orphans);
  });
}

// 메타와 그 산책의 샘플 키를 모두 지운다. expectedId가 있고 다른 산책의 메타면 지우지 않는다.
// 삭제 오류와, 지운 뒤에도 키가 남은 경우는 throw (호출자가 성공으로 취급하지 않게).
export function clearActiveWalk(expectedId) {
  return enqueue(async () => {
    const meta = await readMeta();
    if (expectedId !== undefined && meta && meta.id !== expectedId) return;
    const id = meta ? meta.id : expectedId;
    const keys = await AsyncStorage.getAllKeys();
    const targets = keys.filter(
      (k) => k === META_KEY || (id !== undefined && k.startsWith(samplePrefixFor(id)))
    );
    if (targets.length === 0) return;
    await AsyncStorage.multiRemove(targets);
    const left = new Set(await AsyncStorage.getAllKeys());
    if (targets.some((k) => left.has(k))) {
      throw new Error('임시 기록을 지우지 못했습니다.');
    }
  });
}

// 대기 중인 저장 작업이 모두 끝난 뒤 resolve (종료 직후 마지막 샘플 반영용)
export function whenActiveWalkIdle() {
  return enqueue(async () => {});
}

// 앱이 떠 있을 때 화면이 새 샘플 배치를 받는 구독: listener({ id, samples }). 반환값은 해제 함수.
export function subscribeActiveWalk(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
