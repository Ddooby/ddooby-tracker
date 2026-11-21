import { useState, useRef, useCallback, useEffect, useMemo } from 'react';
import { PermissionsAndroid, Platform } from 'react-native';
import * as Location from 'expo-location';
import { LOCATION_TASK_NAME } from '../tasks/locationTask';
import {
  getActiveWalk,
  startActiveWalk,
  clearActiveWalk,
  whenActiveWalkIdle,
  subscribeActiveWalk,
  cleanupOrphanSamples,
  mergeSamples,
  newWalkId,
} from '../storage/activeWalk';
import { filterValidSamples } from '../utils/track';

const TASK_OPTIONS = {
  accuracy: Location.Accuracy.BestForNavigation,
  timeInterval: 2000,
  distanceInterval: 5,
  foregroundService: {
    notificationTitle: '산책 기록 중',
    notificationBody: '화면이 꺼져도 경로를 기록합니다',
  },
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Android 13+ 에서만 알림 권한이 필요하다. 거부돼도 위치 수집은 계속한다(알림은 표시용).
async function ensureNotificationPermission() {
  if (Platform.OS !== 'android' || Platform.Version < 33) return true;
  try {
    const permission = 'android.permission.POST_NOTIFICATIONS';
    if (await PermissionsAndroid.check(permission)) return true;
    const result = await PermissionsAndroid.request(permission);
    return result === PermissionsAndroid.RESULTS.GRANTED;
  } catch (e) {
    console.warn('[useLocation] notification permission check failed', e?.message ?? e);
    return true; // 상태를 알 수 없으면 안내하지 않는다
  }
}

async function hasForegroundPermission() {
  try {
    const perm = await Location.getForegroundPermissionsAsync();
    return perm.status === 'granted';
  } catch {
    return false;
  }
}

// task를 멈추고 실제로 멈췄는지 확인한다. 등록이 해제됐으면(hasStarted=false) stop 예외가 있었어도
// 성공으로 본다(예외는 경고만). 아직 실행 중이면 최대 3초 재확인 후 한 번 더 stop, 두 번 모두 실패하면 throw.
async function stopAndVerify() {
  let lastError = null;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    let stopError = null;
    try {
      await Location.stopLocationUpdatesAsync(LOCATION_TASK_NAME);
    } catch (e) {
      stopError = e;
    }
    const deadline = Date.now() + 3000;
    let running = true;
    let checkError = null;
    for (;;) {
      try {
        running = await Location.hasStartedLocationUpdatesAsync(LOCATION_TASK_NAME);
        checkError = null;
      } catch (e) {
        checkError = e;
        running = true;
      }
      if (!running || Date.now() >= deadline) break;
      await sleep(500);
    }
    if (!running) {
      if (stopError) {
        console.warn('[useLocation] stop threw but task is unregistered', stopError?.message ?? stopError);
      }
      return;
    }
    lastError = stopError ?? checkError ?? new Error('위치 수집이 중단되지 않았습니다.');
  }
  throw lastError;
}

// 포그라운드 서비스(알림)를 새로 띄운다: 기존 task 정리(실패 무시) 후 같은 옵션으로 재시작.
async function restartService() {
  try {
    await stopAndVerify();
  } catch (e) {
    console.warn('[useLocation] stop before restart failed', e?.message ?? e);
  }
  await Location.startLocationUpdatesAsync(LOCATION_TASK_NAME, TASK_OPTIONS);
}

// 서비스 정리(실패해도 진행). 정리 결과는 경고 로그로만 남긴다.
async function cleanupService() {
  try {
    await stopAndVerify();
  } catch (e) {
    console.warn('[useLocation] service cleanup failed', e?.message ?? e);
  }
}

// startTracking 반환:
//   { ok: true, notificationsBlocked }
//   { ok: false, reason: 'permission', canAskAgain }
//   { ok: false, reason: 'pending-walk', walk }   // 서비스는 꺼졌는데 이전 기록이 남음
//   { ok: false, reason: 'error', message }
// stopTracking 반환:
//   { ok: true, walk }  // walk: { id, startedAt, coords(원본) } | null
//   { ok: false, reason: 'stop-failed' | 'read-failed', message }
// 노출 값: coords(원본), validCoords(유효 샘플), currentLocation(마지막 유효 샘플),
//   acquiring(산책 중인데 아직 유효 샘플이 없음 = GPS 신호 찾는 중)
export default function useLocation() {
  const [coords, setCoords] = useState([]);
  const [isTracking, setIsTracking] = useState(false);
  const [startedAt, setStartedAt] = useState(null);
  const [restoring, setRestoring] = useState(true);
  // 수집 중이 아닌데 기록이 남은 경우(서비스 중단·권한 회수): 화면이 저장/버리기를 묻도록 노출
  const [interruptedWalk, setInterruptedWalk] = useState(null);
  const mountedRef = useRef(true);
  const walkIdRef = useRef(null);
  const opChainRef = useRef(Promise.resolve());

  // 시작·복원·종료를 한 번에 하나씩만 실행한다.
  const runExclusive = useCallback((job) => {
    const run = opChainRef.current.then(job, job);
    opChainRef.current = run.catch(() => {});
    return run;
  }, []);

  const applyWalk = useCallback((walk) => {
    if (!mountedRef.current || !walk) return;
    walkIdRef.current = walk.id;
    setCoords(walk.coords);
    setStartedAt(walk.startedAt);
  }, []);

  // 마운트: 기록이 있으면 복원, 구독 해제는 언마운트 시
  useEffect(() => {
    mountedRef.current = true;
    const unsubscribe = subscribeActiveWalk(({ id, samples }) => {
      if (!mountedRef.current || walkIdRef.current !== id) return;
      setCoords((prev) => mergeSamples(prev, samples));
    });

    runExclusive(async () => {
      try {
        // 메타가 없거나 id가 다른 샘플 키(늦은 쓰기로 남은 고아)를 먼저 지운다.
        try {
          await cleanupOrphanSamples();
        } catch (e) {
          console.warn('[useLocation] orphan cleanup failed', e?.message ?? e);
        }
        const running = await Location.hasStartedLocationUpdatesAsync(LOCATION_TASK_NAME);
        const walk = await getActiveWalk();
        if (!mountedRef.current) return;
        if (walk && running) {
          if (await hasForegroundPermission()) {
            // 프로세스가 죽었다 복원되면 포그라운드 서비스(알림)가 없으므로 다시 띄운다.
            try {
              applyWalk(walk);
              await restartService();
              setIsTracking(true);
            } catch (e) {
              console.warn('[useLocation] restart failed', e?.message ?? e);
              await cleanupService();
              setInterruptedWalk(walk);
            }
          } else {
            // 권한이 회수됨: 수집 중으로 표시하지 않고 서비스 정리 후 저장/버리기로 보낸다.
            await cleanupService();
            setInterruptedWalk(walk);
          }
        } else if (walk && !running) {
          setInterruptedWalk(walk);
        } else if (running) {
          // 기록 없이 서비스만 남은 고아 상태 → 정리
          await cleanupService();
        }
      } catch (e) {
        console.warn('[useLocation] restore failed', e?.message ?? e);
      } finally {
        if (mountedRef.current) setRestoring(false);
      }
    });

    return () => {
      mountedRef.current = false;
      unsubscribe();
    };
  }, [applyWalk, runExclusive]);

  const startTracking = useCallback(
    () =>
      runExclusive(async () => {
        try {
          const perm = await Location.requestForegroundPermissionsAsync();
          if (perm.status !== 'granted') {
            return { ok: false, reason: 'permission', canAskAgain: perm.canAskAgain };
          }

          const running = await Location.hasStartedLocationUpdatesAsync(LOCATION_TASK_NAME);
          const existing = await getActiveWalk();
          if (running && existing) {
            // 이미 진행 중 → 새로 시작하지 않고 서비스만 다시 띄워 이어 붙인다
            applyWalk(existing);
            await restartService();
            setIsTracking(true);
            return { ok: true, notificationsBlocked: false };
          }
          if (existing) {
            // 이전 기록이 남아 있으면 덮어쓰지 않고 저장/버리기를 먼저 처리하게 한다
            return { ok: false, reason: 'pending-walk', walk: existing };
          }
          if (running) await stopAndVerify();

          const notificationsGranted = await ensureNotificationPermission();

          // 단일 getCurrentPosition 값을 출발점으로 쓰지 않는다(첫 값이 수 km 어긋난 사례, TRK-02).
          // 서비스를 바로 시작하고 첫 유효 샘플(accuracy ≤ 20m)을 기다린다(acquiring).
          // id는 위치 timestamp와 분리된 고유값
          const walk = { id: newWalkId(), startedAt: Date.now() };
          await startActiveWalk(walk, []);
          applyWalk({ ...walk, coords: [] });
          try {
            await Location.startLocationUpdatesAsync(LOCATION_TASK_NAME, TASK_OPTIONS);
          } catch (e) {
            await clearActiveWalk(walk.id);
            throw e;
          }
          setInterruptedWalk(null);
          setIsTracking(true);
          return { ok: true, notificationsBlocked: !notificationsGranted };
        } catch (e) {
          return { ok: false, reason: 'error', message: e?.message ?? String(e) };
        }
      }),
    [applyWalk, runExclusive]
  );

  // 수집 중단을 확인한 뒤 임시 기록을 읽어 반환한다. 어느 단계든 실패하면 isTracking과 임시 기록을
  // 그대로 두고 실패를 반환한다. 재시도할 때 서비스가 이미 멈춰 있으면 중단은 건너뛰고 기록만 읽는다.
  const stopTracking = useCallback(
    () =>
      runExclusive(async () => {
        try {
          if (await Location.hasStartedLocationUpdatesAsync(LOCATION_TASK_NAME)) {
            await stopAndVerify();
          }
        } catch (e) {
          return { ok: false, reason: 'stop-failed', message: e?.message ?? String(e) };
        }
        try {
          await whenActiveWalkIdle();
          const walk = await getActiveWalk();
          if (mountedRef.current) setIsTracking(false);
          return { ok: true, walk };
        } catch (e) {
          return { ok: false, reason: 'read-failed', message: e?.message ?? String(e) };
        }
      }),
    [runExclusive]
  );

  const resetTracking = useCallback(() => {
    walkIdRef.current = null;
    setCoords([]);
    setStartedAt(null);
    setInterruptedWalk(null);
  }, []);

  const validCoords = useMemo(() => filterValidSamples(coords), [coords]);
  const currentLocation = useMemo(() => {
    const last = validCoords[validCoords.length - 1];
    return last ? { latitude: last.latitude, longitude: last.longitude } : null;
  }, [validCoords]);
  const acquiring = isTracking && validCoords.length === 0;

  return {
    currentLocation,
    coords,
    validCoords,
    acquiring,
    isTracking,
    startedAt,
    restoring,
    interruptedWalk,
    startTracking,
    stopTracking,
    resetTracking,
    clearActiveWalk,
  };
}
