import { useState, useRef, useCallback, useEffect } from 'react';
import { PermissionsAndroid, Platform } from 'react-native';
import * as Location from 'expo-location';
import { LOCATION_TASK_NAME } from '../tasks/locationTask';
import {
  getActiveWalk,
  startActiveWalk,
  clearActiveWalk,
  whenActiveWalkIdle,
  subscribeActiveWalk,
  toSample,
} from '../storage/activeWalk';

const TASK_OPTIONS = {
  accuracy: Location.Accuracy.BestForNavigation,
  timeInterval: 2000,
  distanceInterval: 5,
  foregroundService: {
    notificationTitle: '산책 기록 중',
    notificationBody: '화면이 꺼져도 경로를 기록합니다',
  },
};

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

async function stopAndVerify() {
  await Location.stopLocationUpdatesAsync(LOCATION_TASK_NAME);
  if (await Location.hasStartedLocationUpdatesAsync(LOCATION_TASK_NAME)) {
    throw new Error('위치 수집이 중단되지 않았습니다.');
  }
}

// startTracking 반환:
//   { ok: true, notificationsBlocked }
//   { ok: false, reason: 'permission', canAskAgain }
//   { ok: false, reason: 'pending-walk', walk }   // 서비스는 꺼졌는데 이전 기록이 남음
//   { ok: false, reason: 'error', message }
// stopTracking 반환:
//   { ok: true, walk }  // walk: { id, startedAt, coords } | null
//   { ok: false, reason: 'stop-failed', message }
export default function useLocation() {
  const [currentLocation, setCurrentLocation] = useState(null);
  const [coords, setCoords] = useState([]);
  const [isTracking, setIsTracking] = useState(false);
  const [startedAt, setStartedAt] = useState(null);
  const [restoring, setRestoring] = useState(true);
  // task 없이 '@active_walk'만 남은 경우(서비스가 중단됨): 화면이 저장/버리기를 묻도록 노출
  const [interruptedWalk, setInterruptedWalk] = useState(null);
  const mountedRef = useRef(true);
  const opChainRef = useRef(Promise.resolve());

  // 시작·복원·종료를 한 번에 하나씩만 실행한다.
  const runExclusive = useCallback((job) => {
    const run = opChainRef.current.then(job, job);
    opChainRef.current = run.catch(() => {});
    return run;
  }, []);

  const applyWalk = useCallback((walk) => {
    if (!mountedRef.current || !walk) return;
    setCoords(walk.coords);
    setStartedAt(walk.startedAt);
    const last = walk.coords[walk.coords.length - 1];
    if (last) setCurrentLocation({ latitude: last.latitude, longitude: last.longitude });
  }, []);

  // 마운트: task가 돌고 있으면 진행 중 산책 복원, 구독 해제는 언마운트 시
  useEffect(() => {
    mountedRef.current = true;
    const unsubscribe = subscribeActiveWalk(applyWalk);

    runExclusive(async () => {
      try {
        const running = await Location.hasStartedLocationUpdatesAsync(LOCATION_TASK_NAME);
        const walk = await getActiveWalk();
        if (!mountedRef.current) return;
        if (running && walk) {
          applyWalk(walk);
          setIsTracking(true);
        } else if (!running && walk) {
          setInterruptedWalk(walk);
        } else if (running && !walk) {
          // 데이터 없이 서비스만 남은 고아 상태 → 정리
          await stopAndVerify();
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
            // 이미 진행 중 → 중복 시작하지 않고 이어 붙인다
            applyWalk(existing);
            setIsTracking(true);
            return { ok: true, notificationsBlocked: false };
          }
          if (!running && existing) {
            // 이전 기록이 남아 있으면 덮어쓰지 않고 저장/버리기를 먼저 처리하게 한다
            return { ok: false, reason: 'pending-walk', walk: existing };
          }
          if (running && !existing) await stopAndVerify();

          const notificationsGranted = await ensureNotificationPermission();

          const initial = await Location.getCurrentPositionAsync({
            accuracy: Location.Accuracy.BestForNavigation,
          });
          const startedAtMs = Date.now();
          const walk = {
            id: String(startedAtMs),
            startedAt: startedAtMs,
            coords: [toSample(initial)],
          };
          await startActiveWalk(walk);
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

  // 수집 중단을 확인한 뒤에만 성공을 반환한다. 실패하면 isTracking과 '@active_walk'를 유지한다.
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
        await whenActiveWalkIdle();
        const walk = await getActiveWalk();
        if (mountedRef.current) setIsTracking(false);
        return { ok: true, walk };
      }),
    [runExclusive]
  );

  const resetTracking = useCallback(() => {
    setCoords([]);
    setCurrentLocation(null);
    setStartedAt(null);
    setInterruptedWalk(null);
  }, []);

  return {
    currentLocation,
    coords,
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
