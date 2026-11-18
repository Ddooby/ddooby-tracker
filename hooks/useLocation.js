import { useState, useRef, useCallback, useEffect } from 'react';
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

// 반환: { ok: true } | { ok: false, reason: 'permission', canAskAgain } | { ok: false, reason: 'error', message }
export default function useLocation() {
  const [currentLocation, setCurrentLocation] = useState(null);
  const [coords, setCoords] = useState([]);
  const [isTracking, setIsTracking] = useState(false);
  const [startedAt, setStartedAt] = useState(null);
  // task 없이 '@active_walk'만 남은 경우(서비스가 중단됨): 화면이 저장/버리기를 묻도록 노출
  const [interruptedWalk, setInterruptedWalk] = useState(null);
  const mountedRef = useRef(true);

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

    (async () => {
      try {
        const [running, walk] = await Promise.all([
          Location.hasStartedLocationUpdatesAsync(LOCATION_TASK_NAME),
          getActiveWalk(),
        ]);
        if (!mountedRef.current) return;
        if (running && walk) {
          applyWalk(walk);
          setIsTracking(true);
        } else if (!running && walk) {
          setInterruptedWalk(walk);
        } else if (running && !walk) {
          // 데이터 없이 서비스만 남은 고아 상태 → 정리
          await Location.stopLocationUpdatesAsync(LOCATION_TASK_NAME);
        }
      } catch (e) {
        console.warn('[useLocation] restore failed', e?.message ?? e);
      }
    })();

    return () => {
      mountedRef.current = false;
      unsubscribe();
    };
  }, [applyWalk]);

  const startTracking = useCallback(async () => {
    try {
      const perm = await Location.requestForegroundPermissionsAsync();
      if (perm.status !== 'granted') {
        return { ok: false, reason: 'permission', canAskAgain: perm.canAskAgain };
      }

      if (await Location.hasStartedLocationUpdatesAsync(LOCATION_TASK_NAME)) {
        const walk = await getActiveWalk();
        if (walk) {
          // 이미 진행 중 → 중복 시작하지 않고 이어 붙인다
          applyWalk(walk);
          setIsTracking(true);
          return { ok: true };
        }
        await Location.stopLocationUpdatesAsync(LOCATION_TASK_NAME);
      }

      const initial = await Location.getCurrentPositionAsync({
        accuracy: Location.Accuracy.BestForNavigation,
      });
      const walk = { startedAt: Date.now(), coords: [toSample(initial)] };
      await startActiveWalk(walk);
      try {
        await Location.startLocationUpdatesAsync(LOCATION_TASK_NAME, TASK_OPTIONS);
      } catch (e) {
        await clearActiveWalk();
        throw e;
      }
      setInterruptedWalk(null);
      setIsTracking(true);
      return { ok: true };
    } catch (e) {
      return { ok: false, reason: 'error', message: e?.message ?? String(e) };
    }
  }, [applyWalk]);

  // 수집 중단 후 최종 coords 반환. '@active_walk'는 clearActiveWalk로 따로 지운다.
  const stopTracking = useCallback(async () => {
    try {
      if (await Location.hasStartedLocationUpdatesAsync(LOCATION_TASK_NAME)) {
        await Location.stopLocationUpdatesAsync(LOCATION_TASK_NAME);
      }
    } catch (e) {
      console.warn('[useLocation] stop failed', e?.message ?? e);
    }
    await whenActiveWalkIdle();
    const walk = await getActiveWalk();
    if (mountedRef.current) setIsTracking(false);
    return walk ? walk.coords : [];
  }, []);

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
    interruptedWalk,
    startTracking,
    stopTracking,
    resetTracking,
    clearActiveWalk,
  };
}
