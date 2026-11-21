import AsyncStorage from '@react-native-async-storage/async-storage';

// 진행 중 산책 임시 저장소. '@walks_history'와 별개이며 저장/버리기 확정 시 삭제한다.
//
// 구조 (헤드리스 task와 UI가 같은 키를 읽고-수정-쓰지 않도록 분리)
//   '@active_walk'                                   메타만: { id, startedAt, endedAt?, lastAliveAt? }
//     lastAliveAt: 앱이 화면에 있는 동안 주기적으로 기록하는 "마지막으로 살아 있던 시각"(추정 종료 시각용)
//     endedAt: 사용자가 종료를 눌러 서비스 중단이 확정된 뒤 기록하는 종료 시각(ms). 한 번 기록되면 유지된다.
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
    const endedAt = typeof meta.endedAt === 'number' ? meta.endedAt : undefined;
    const lastAliveAt = typeof meta.lastAliveAt === 'number' ? meta.lastAliveAt : undefined;
    return { id: meta.id, startedAt: meta.startedAt, endedAt, lastAliveAt, coords };
  });
}

// 종료 시각을 메타에 영속화한다(메타 전용, 샘플 키는 건드리지 않는다). 전체 샘플을 읽기 전에 호출한다.
// 이미 기록돼 있으면 처음 값을 유지한다. 반환: { endedAt, created } — created는 이번 호출에서 새로 쓴 값인지
// 여부(기존 값이면 false). 메타가 없거나 id(주어진 경우)가 다르면 null. 쓰기 오류는 호출자에게 전달한다.
export function markActiveWalkEnded(id, endedAt) {
  return enqueue(async () => {
    const meta = await readMeta();
    if (!meta || (id !== undefined && id !== null && meta.id !== id)) return null;
    if (typeof meta.endedAt === 'number') return { endedAt: meta.endedAt, created: false };
    // 이전 형식 메타(인라인 coords/samples)도 잃지 않도록 메타 전체를 그대로 두고 endedAt만 더한다.
    await AsyncStorage.setItem(META_KEY, JSON.stringify({ ...meta, endedAt }));
    return { endedAt, created: true };
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

// 산책 중 앱이 화면에 있을 때 "마지막으로 살아 있던 시각"을 메타에 기록한다(메타 전용, 샘플 키 불변, 직렬 큐).
// 이미 종료 시각이 기록됐거나 메타가 없거나 id가 다르면, 또는 더 이른 시각이면 쓰지 않는다. 호출자는 오류를 무시해도 된다.
export function touchActiveWalkAlive(id, at) {
  return enqueue(async () => {
    const meta = await readMeta();
    if (!meta || (id !== undefined && id !== null && meta.id !== id)) return false;
    if (typeof meta.endedAt === 'number') return false;
    if (typeof meta.lastAliveAt === 'number' && meta.lastAliveAt >= at) return false;
    await AsyncStorage.setItem(META_KEY, JSON.stringify({ ...meta, lastAliveAt: at }));
    return true;
  });
}

// 하트비트 판정(서비스·foreground 권한 확인 후에만 lastAliveAt 기록):
//   'alive'   서비스 실행 중 + 권한 granted 로 확인 → lastAliveAt 기록
//   'lost'    hasStarted=false 이거나 권한 status가 granted가 아님으로 "확인"됨 → 기록하지 않음
//   'unknown' 조회가 예외 → 기록하지 않음. 서비스 중단·전환은 하지 않는다(호출자는 다음 주기에 재조회).
// 권한 조회 예외를 false(=권한 없음)로 바꾸지 않는다: 수집 지속이 안전한 기본값이다. 기록 오류는 무시한다.
export async function beatIfServiceAlive({ walkId, isServiceRunning, hasPermission, now = Date.now }) {
  let running;
  try {
    running = Boolean(await isServiceRunning());
  } catch {
    return 'unknown';
  }
  if (!running) return 'lost';
  let granted;
  try {
    granted = Boolean(await hasPermission());
  } catch {
    return 'unknown';
  }
  if (!granted) return 'lost';
  try {
    await touchActiveWalkAlive(walkId, now());
  } catch (e) {
    console.warn('[activeWalk] heartbeat write failed', e?.message ?? e);
  }
  return 'alive';
}

// 현재 진행 중 산책 메타의 id(없으면 null). 읽기 오류는 호출자에게 전달한다. (임시 기록 전체를 읽지 않는 가벼운 조회)
export function peekActiveWalkId() {
  return enqueue(async () => {
    const meta = await readMeta();
    return meta ? meta.id : null;
  });
}

// 하트비트 한 주기. 반환:
//   { status: 'alive' | 'unknown' }  기록했거나(alive) 조회가 불확실(unknown: 서비스는 그대로 두고 다음 주기에 재조회,
//                                     반복 실패해도 서비스는 멈추지 않는다)
//   { status: 'lost', walk }         서비스 중단·권한 없음이 확인됐고 임시 기록 읽기·서비스 정리까지 끝남(전환 완료)
//   { status: 'lost-pending' }       lost는 확인됐지만 읽기가 실패 → 완료로 보지 않으며 호출자는 하트비트를
//                                     멈추지 말고 다음 주기에 (lostPending=true, lostWalkId 고정)로 읽기·정리를 재시도한다
//   { status: 'lost-stale' }         재시도 때 현재 메타가 없거나 id가 lostWalkId와 다름(이미 저장/버리기로 정리됐고
//                                     다른 산책이 시작됐을 수 있음) → 정리·읽기 없이 pending만 해제하고 종료한다
// lost를 처음 확인한 순간 onLostDetected(walkId)를 한 번 호출한다(호출자가 화면 수집 상태를 먼저 내리고 산책 id를 고정).
// 재시도는 항상 그 id의 산책에만 작용한다(새 산책의 서비스를 멈추지 않는다).
export async function heartbeatStep({
  lostPending = false,
  lostWalkId,
  walkId,
  isServiceRunning,
  hasPermission,
  cleanupService,
  onLostDetected,
  now = Date.now,
}) {
  if (lostPending) {
    let currentId;
    try {
      currentId = await peekActiveWalkId();
    } catch {
      return { status: 'lost-pending' };
    }
    if (currentId === null || currentId !== lostWalkId) return { status: 'lost-stale' };
  } else {
    const status = await beatIfServiceAlive({ walkId, isServiceRunning, hasPermission, now });
    if (status !== 'lost') return { status };
    let id = walkId;
    if (id === undefined || id === null) {
      try {
        id = (await peekActiveWalkId()) ?? undefined;
      } catch {
        id = undefined;
      }
    }
    onLostDetected?.(id);
  }
  try {
    await cleanupService(); // 남은 서비스·알림 정리(구현은 실패를 경고로만 남김)
    const walk = await getActiveWalk();
    return { status: 'lost', walk };
  } catch {
    return { status: 'lost-pending' };
  }
}

// 서비스를 끝내 멈추지 못했을 때 영속화한 종료 시각을 지운다(수집이 계속되는 산책으로 되돌린다). 메타 전용.
export function clearActiveWalkEnded(id) {
  return enqueue(async () => {
    const meta = await readMeta();
    if (!meta || (id !== undefined && id !== null && meta.id !== id)) return;
    if (meta.endedAt === undefined) return;
    const { endedAt, ...rest } = meta;
    await AsyncStorage.setItem(META_KEY, JSON.stringify(rest));
  });
}

// 산책 종료 시퀀스(서비스 중단 + 임시 기록 읽기). 위치 라이브러리와 분리하려고 서비스 제어는 주입받는다.
// 1) 종료 시각을 메타에 먼저 영속화(첫 값 유지) → 2) 서비스 상태 확인·중단 → 3) 임시 기록 읽기.
// 영속화한 종료 시각은 "이번 시도에서 새로 쓴 값"이고 "서비스가 계속 실행 중임을 확인한" 경우에만 지운다
// (stop-failed). 상태 조회가 오류이거나 중단 여부가 불확실하면(stop-unconfirmed) 지우지 않는다.
// 반환: { ok: true, walk }(walk.endedAt = 영속 값)
//   | { ok: false, reason: 'stop-failed', message }       서비스가 계속 실행 중임을 확인(수집 지속)
//   | { ok: false, reason: 'stop-unconfirmed', message }  중단 여부를 확인하지 못함(종료 시각 보존, 재시도·복원이 사용)
//   | { ok: false, reason: 'read-failed', message }       서비스는 이미 멈춤(종료 시각 보존)
export async function finishCollection({ walkId, endedAt, isServiceRunning, stopService }) {
  let persisted;
  let created = false;
  if (typeof endedAt === 'number') {
    try {
      const marked = await markActiveWalkEnded(walkId, endedAt);
      if (marked) {
        persisted = marked.endedAt;
        created = marked.created;
      }
    } catch (e) {
      return { ok: false, reason: 'stop-failed', message: e?.message ?? String(e) }; // 쓰기 전: 서비스는 그대로
    }
  }
  const unconfirmed = (e) => ({
    ok: false,
    reason: 'stop-unconfirmed',
    message: e?.message ?? String(e ?? '서비스 상태를 확인하지 못했습니다.'),
  });
  const confirmedRunning = async (e) => {
    // 이번 시도에서 새로 쓴 종료 시각만 지운다(기존 값은 그대로).
    if (created) {
      try {
        await clearActiveWalkEnded(walkId);
      } catch (clearError) {
        console.warn('[activeWalk] clear endedAt failed', clearError?.message ?? clearError);
      }
    }
    return { ok: false, reason: 'stop-failed', message: e?.message ?? String(e) };
  };

  let running;
  try {
    running = await isServiceRunning();
  } catch (e) {
    return unconfirmed(e);
  }
  if (running) {
    try {
      await stopService();
    } catch (stopError) {
      // 중단 실패가 곧 "계속 실행 중"은 아니다: 다시 조회해 실행 중임이 확인된 경우에만 stop-failed.
      let stillRunning;
      try {
        stillRunning = await isServiceRunning();
      } catch (e) {
        return unconfirmed(e);
      }
      if (stillRunning) return confirmedRunning(stopError);
      // 오류가 있었지만 서비스는 멈춰 있다 → 읽기로 진행
    }
  }
  try {
    await whenActiveWalkIdle();
    const walk = await getActiveWalk();
    if (walk && persisted !== undefined) walk.endedAt = walk.endedAt ?? persisted;
    return { ok: true, walk };
  } catch (e) {
    return { ok: false, reason: 'read-failed', message: e?.message ?? String(e) };
  }
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

// 메타를 먼저 지운 뒤 그 산책의 샘플 키를 조회·삭제하고 재조회로 확인한다 (expectedId가 다른 산책의
// 메타면 지우지 않는다). task는 쓰기 직후 메타를 다시 읽으므로, 메타 삭제 뒤 목록 조회 전에 쓴 키는
// 목록에 잡혀 지워지고, 조회 뒤에 쓴 키는 task가 메타 없음을 보고 스스로 지운다. task 프로세스가
// 쓰기와 재확인 사이에 죽으면 다음 실행의 cleanupOrphanSamples가 정리한다. 종료 순간 진행 중이던
// 배치의 샘플은 저장 기록에서 빠질 수 있다(사용자 수용, 2026-11-19).
// 삭제 오류와 지운 뒤에도 키가 남은 경우는 throw (호출자가 성공으로 취급하지 않게).
export function clearActiveWalk(expectedId) {
  return enqueue(async () => {
    const meta = await readMeta();
    if (expectedId !== undefined && meta && meta.id !== expectedId) return;
    const id = meta ? meta.id : expectedId;

    await AsyncStorage.removeItem(META_KEY);
    if (await readMeta()) throw new Error('임시 기록을 지우지 못했습니다.');
    if (id === undefined) return;

    const prefix = samplePrefixFor(id);
    let left = await keysWithPrefix(prefix);
    for (let attempt = 0; attempt < 2 && left.length > 0; attempt += 1) {
      await AsyncStorage.multiRemove(left);
      left = await keysWithPrefix(prefix); // 재조회로 남은 키 확인
    }
    if (left.length > 0) throw new Error('임시 기록을 지우지 못했습니다.');
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
